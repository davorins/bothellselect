const express = require('express');
const router = express.Router();
const Form = require('../models/Form');
const FormSubmission = require('../models/FormSubmission');
const { authenticate } = require('../utils/auth');
const { submitPayment } = require('../services/square-payments');
const { body, validationResult } = require('express-validator');
const mongoose = require('mongoose');
const crypto = require('crypto');
const {
  sendFormPaymentReceiptEmail,
  sendFormOwnerNotificationEmail,
} = require('../utils/email');

// Form validation middleware
const validateForm = [
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('description').optional().trim(),
  body('fields')
    .isArray({ min: 1 })
    .withMessage('Fields must be an array with at least one field'),
  body('fields.*.id').notEmpty().withMessage('Field ID is required'),
  body('fields.*.type')
    .isIn([
      'text',
      'email',
      'number',
      'select',
      'checkbox',
      'radio',
      'payment',
      'section',
      'textarea',
      'file',
      'heading',
      'divider',
    ])
    .withMessage('Invalid field type'),
  body('fields.*.label').notEmpty().withMessage('Field label is required'),
  body('fields.*.required').optional().isBoolean(),
  body('fields.*.paymentConfig')
    .if(body('fields.*.type').equals('payment'))
    .notEmpty()
    .withMessage('Payment config is required for payment fields')
    .custom((value) => {
      if (value && (!value.amount || isNaN(value.amount))) {
        throw new Error('Payment amount must be a number');
      }
      return true;
    }),
];

// ========== FORM SUBMISSION WITH PAYMENT ==========

// Get published form by ID or shortcode
router.get('/published/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;

    const form = await Form.findOne({
      $or: [{ _id: identifier }, { shortcode: identifier }],
      status: 'published',
    })
      .populate('createdBy', 'name email')
      .lean();

    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found or not published',
      });
    }

    // Increment view count
    await Form.updateOne({ _id: form._id }, { $inc: { views: 1 } });

    res.json({
      success: true,
      data: form,
    });
  } catch (err) {
    console.error('Error fetching form:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch form',
    });
  }
});

// Submit form data with payment processing
router.post('/:id/submit', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const form = await Form.findById(req.params.id).session(session);
    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found',
      });
    }

    if (form.status !== 'published') {
      return res.status(400).json({
        success: false,
        error: 'Form is not published',
      });
    }

    console.log('=== FORM SUBMISSION DEBUG ===');
    console.log('Form:', form.title);
    console.log('Form ID:', form._id);
    console.log('Request body keys:', Object.keys(req.body));
    console.log(
      'Data keys:',
      req.body.data ? Object.keys(req.body.data) : 'No data'
    );

    // Extract ALL possible data
    const {
      email,
      name,
      userEmail,
      userName,
      data: submittedData = {},
      metadata = {},
      selectedPackage: submittedPackage,
      quantity: submittedQuantity = 1,
      skipPayment = false,
    } = req.body;

    // COMBINE EVERYTHING
    const allData = { ...submittedData };

    // Add root level fields to data
    if (email) allData.email = email;
    if (userEmail) allData.userEmail = userEmail;
    if (name) allData.name = name;
    if (userName) allData.userName = userName;

    // Get final email and name from ANY source
    const finalEmail =
      email || userEmail || allData.email || allData.userEmail || '';
    const finalName =
      name || userName || allData.name || allData.userName || '';

    console.log('Email sources:', {
      email,
      userEmail,
      dataEmail: allData.email,
      dataUserEmail: allData.userEmail,
      finalEmail,
    });
    console.log('Name sources:', {
      name,
      userName,
      dataName: allData.name,
      dataUserName: allData.userName,
      finalName,
    });

    // VALIDATION - SIMPLIFIED SINGLE PASS
    const validationErrors = [];

    // Validate ALL form fields (including email, name, and any other required fields)
    form.fields.forEach((field) => {
      if (field.type === 'payment') return; // Skip payment fields entirely

      // Only validate if field is marked as required in the form configuration
      if (field.required) {
        // Try to find the value from all possible sources
        let fieldValue = allData[field.id] || allData[field.name] || '';

        // SPECIAL HANDLING: For email fields, also check root email
        if (field.type === 'email' && !fieldValue) {
          fieldValue = finalEmail;
        }

        // SPECIAL HANDLING: For name fields, also check root name
        if (
          field.type === 'text' &&
          (field.label?.toLowerCase().includes('name') ||
            field.name?.toLowerCase().includes('name')) &&
          !fieldValue
        ) {
          fieldValue = finalName;
        }

        console.log(
          `Validating form field: ${field.label} (${field.type}), required: ${field.required}, value: "${fieldValue}"`
        );

        // Check if value is empty
        if (!fieldValue || fieldValue.toString().trim() === '') {
          validationErrors.push(`${field.label} is required`);
        } else {
          // Additional validation for specific field types
          const trimmedValue = fieldValue.toString().trim();

          // Email validation
          if (field.type === 'email') {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(trimmedValue)) {
              validationErrors.push('Please enter a valid email address');
            }
          }

          // Number validation
          if (field.type === 'number') {
            const numValue = parseFloat(trimmedValue);
            if (isNaN(numValue)) {
              validationErrors.push(`${field.label} must be a valid number`);
            } else {
              if (
                field.validation?.min !== undefined &&
                numValue < field.validation.min
              ) {
                validationErrors.push(
                  `${field.label} must be at least ${field.validation.min}`
                );
              }
              if (
                field.validation?.max !== undefined &&
                numValue > field.validation.max
              ) {
                validationErrors.push(
                  `${field.label} must be at most ${field.validation.max}`
                );
              }
            }
          }

          // Text length validation
          if (
            field.type === 'text' ||
            field.type === 'textarea' ||
            field.type === 'password'
          ) {
            if (
              field.validation?.minLength !== undefined &&
              trimmedValue.length < field.validation.minLength
            ) {
              validationErrors.push(
                `${field.label} must be at least ${field.validation.minLength} characters`
              );
            }
            if (
              field.validation?.maxLength !== undefined &&
              trimmedValue.length > field.validation.maxLength
            ) {
              validationErrors.push(
                `${field.label} must be at most ${field.validation.maxLength} characters`
              );
            }
          }

          // URL validation
          if (field.type === 'url') {
            try {
              new URL(trimmedValue);
            } catch (err) {
              validationErrors.push(`${field.label} must be a valid URL`);
            }
          }

          // Phone validation (basic)
          if (field.type === 'tel') {
            const phoneRegex = /^[\+]?[1-9][\d]{0,15}$/;
            const cleanedPhone = trimmedValue.replace(/[\s\-\(\)]/g, '');
            if (!phoneRegex.test(cleanedPhone)) {
              validationErrors.push(
                `${field.label} must be a valid phone number`
              );
            }
          }
        }
      }
    });

    console.log('Validation errors:', validationErrors);

    if (validationErrors.length > 0) {
      return res.status(400).json({
        success: false,
        errors: validationErrors,
        error: 'Validation failed',
      });
    }

    // Add email/name to data if not already there
    if (!allData.email) allData.email = finalEmail;
    if (!allData.userEmail) allData.userEmail = finalEmail;
    if (!allData.name) allData.name = finalName;
    if (!allData.userName) allData.userName = finalName;

    // Check for payment fields
    const paymentFields = form.fields.filter((f) => f.type === 'payment');
    const hasPaymentFields = paymentFields.length > 0;

    let submissionStatus = 'submitted';
    let requiresPayment = false;

    if (hasPaymentFields) {
      if (skipPayment) {
        submissionStatus = 'payment_skipped';
        requiresPayment = false;
      } else {
        submissionStatus = 'pending';
        requiresPayment = true;
      }
    }

    // Create the submission
    const submission = new FormSubmission({
      formId: form._id,
      formVersion: form.version || 1,
      data: allData,
      userEmail: finalEmail,
      userName: finalName,
      submittedBy: req.user?.id,
      ipAddress:
        req.ip ||
        req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      referrer: req.headers['referer'] || req.headers['referrer'],
      pageUrl: req.body.pageUrl || req.headers['origin'] || '',
      metadata: {
        ...metadata,
        userAgent: req.headers['user-agent'],
        ipAddress: req.ip,
        submittedStep: 'form_data',
      },
      status: submissionStatus,
    });

    // Add payment info if needed
    if (hasPaymentFields) {
      submission.payment = {
        status: requiresPayment ? 'pending' : 'skipped',
        amount: 0,
        currency: paymentFields[0]?.paymentConfig?.currency || 'USD',
        gateway: 'square',
        metadata: {
          requiresPayment: requiresPayment,
          paymentFieldsCount: paymentFields.length,
        },
      };
    }

    await submission.save({ session });

    // Update form stats
    form.submissions = (form.submissions || 0) + 1;
    await form.save({ session });

    await session.commitTransaction();

    console.log('=== SUBMISSION CREATED ===');
    console.log('Submission ID:', submission._id);
    console.log('Status:', submission.status);
    console.log('User Email:', submission.userEmail);
    console.log('User Name:', submission.userName);

    // Return success
    const response = {
      success: true,
      data: {
        _id: submission._id,
        formId: submission.formId,
        userEmail: submission.userEmail,
        status: submission.status,
        createdAt: submission.createdAt,
        requiresPayment: requiresPayment,
      },
      submissionId: submission._id,
      message: requiresPayment
        ? 'Form submitted successfully. Please complete payment to finalize.'
        : 'Form submitted successfully.',
    };

    // Add payment info if needed
    if (requiresPayment && paymentFields.length > 0) {
      const paymentField = paymentFields[0];
      response.paymentInfo = {
        fieldId: paymentField.id,
        fieldLabel: paymentField.label,
        pricingPackages: paymentField.paymentConfig?.pricingPackages || [],
        currency: paymentField.paymentConfig?.currency || 'USD',
        fixedAmount: paymentField.paymentConfig?.amount || 0,
      };

      if (submittedPackage && paymentField.paymentConfig?.pricingPackages) {
        const selectedPkg = paymentField.paymentConfig.pricingPackages.find(
          (pkg) => pkg.name === submittedPackage
        );
        if (selectedPkg) {
          const quantity = parseInt(submittedQuantity) || selectedPkg.quantity;
          response.paymentInfo.estimatedAmount = selectedPkg.price * quantity;
          response.paymentInfo.selectedPackage = {
            name: selectedPkg.name,
            price: selectedPkg.price,
            quantity: quantity,
          };
        }
      }
    }

    res.json(response);
  } catch (err) {
    await session.abortTransaction();
    console.error('Form submission error:', err);
    res.status(400).json({
      success: false,
      error: err.message || 'Failed to submit form',
    });
  } finally {
    session.endSession();
  }
});

// ========== HELPER FUNCTIONS ==========

async function sendFormSubmissionEmail(form, submission, recipients) {
  // This function should be implemented in your email service
  console.log('Would send form submission email to:', recipients);
  console.log('Form:', form.title);
  console.log('Submission ID:', submission._id);

  // Example implementation (you should use your actual email service):
  /*
  const emailData = {
    to: recipients,
    subject: `New Form Submission: ${form.title}`,
    html: `
      <h2>New Form Submission</h2>
      <p><strong>Form:</strong> ${form.title}</p>
      <p><strong>Submitted by:</strong> ${submission.userName || 'N/A'} (${submission.userEmail})</p>
      <p><strong>Date:</strong> ${new Date(submission.createdAt).toLocaleString()}</p>
      <h3>Submission Data:</h3>
      <pre>${JSON.stringify(submission.data, null, 2)}</pre>
      ${submission.payment ? `<p><strong>Payment Status:</strong> ${submission.payment.status}</p>` : ''}
    `,
  };
  
  // Call your email service here
  await sendEmail(emailData);
  */
}

async function sendFormSubmissionConfirmation(form, submission, options = {}) {
  const { isPendingPayment = false } = options;

  console.log(
    'Sending form submission confirmation email to:',
    submission.userEmail
  );
  console.log('Form:', form.title);
  console.log('Submission ID:', submission._id);
  console.log('Pending payment:', isPendingPayment);

  // This function should be implemented in your email service
  // Example implementation:
  /*
  const subject = isPendingPayment 
    ? `Your ${form.title} Submission - Payment Pending` 
    : `Thank you for your ${form.title} submission`;
  
  const emailData = {
    to: submission.userEmail,
    subject: subject,
    html: `
      <h2>${form.title}</h2>
      <p>Thank you for your submission!</p>
      ${isPendingPayment ? `
        <p><strong>Next Step:</strong> Please complete your payment to finalize the submission.</p>
        <p>You can complete your payment at: [Payment Link]</p>
      ` : ''}
      <p><strong>Submission ID:</strong> ${submission._id}</p>
      <p><strong>Date:</strong> ${new Date(submission.createdAt).toLocaleString()}</p>
      <h3>Your Submission:</h3>
      <pre>${JSON.stringify(submission.data, null, 2)}</pre>
      ${form.settings.successMessage ? `<p>${form.settings.successMessage}</p>` : ''}
    `,
  };
  
  await sendEmail(emailData);
  */
}

async function sendConfirmationEmail(form, submission) {
  // This function should be implemented in your email service
  console.log('Would send confirmation email to:', submission.userEmail);
  console.log('Form:', form.title);
  console.log('Submission ID:', submission._id);

  // This is a legacy function, you might want to use sendFormSubmissionConfirmation instead
  await sendFormSubmissionConfirmation(form, submission);
}

async function sendPaymentConfirmationEmail(form, submission, paymentData) {
  // This function should be implemented in your email service
  console.log(
    'Would send payment confirmation email to:',
    submission.userEmail
  );
  console.log('Payment amount:', paymentData.amount, paymentData.currency);
  console.log('Transaction ID:', paymentData.transactionId);

  // Example implementation:
  /*
  const emailData = {
    to: submission.userEmail,
    subject: `Payment Confirmation - ${form.title}`,
    html: `
      <h2>Payment Confirmation</h2>
      <p>Your payment has been successfully processed.</p>
      <p><strong>Form:</strong> ${form.title}</p>
      <p><strong>Amount:</strong> ${paymentData.amount} ${paymentData.currency}</p>
      <p><strong>Transaction ID:</strong> ${paymentData.transactionId}</p>
      <p><strong>Date:</strong> ${new Date().toLocaleString()}</p>
      ${paymentData.receiptUrl ? `<p><a href="${paymentData.receiptUrl}">Download Receipt</a></p>` : ''}
      ${paymentData.package ? `<p><strong>Package:</strong> ${paymentData.package.name} (Quantity: ${paymentData.package.quantity})</p>` : ''}
      <h3>Your Submission Details:</h3>
      <pre>${JSON.stringify(submission.data, null, 2)}</pre>
    `,
  };
  
  await sendEmail(emailData);
  */
}

// ========== PAYMENT PROCESSING ENDPOINT ==========

// Process form payment separately (for direct payment processing)
router.post(
  '/:id/process-payment',
  [
    body('token').notEmpty().withMessage('Payment token is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('cardDetails').isObject().withMessage('Card details are required'),
    body('cardDetails.last_4')
      .optional()
      .isLength({ min: 4, max: 4 })
      .withMessage('Invalid card last 4 digits'),
    body('submissionId').notEmpty().withMessage('Submission ID is required'),
    body('selectedPackage').optional(),
    body('quantity').optional().isInt({ min: 1 }),
  ],
  async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          errors: errors.array(),
        });
      }

      const {
        token,
        email,
        cardDetails,
        submissionId,
        selectedPackage,
        quantity = 1,
        metadata = {},
      } = req.body;

      const form = await Form.findById(req.params.id).session(session);
      if (!form) {
        return res.status(404).json({
          success: false,
          error: 'Form not found',
        });
      }

      // Find the submission
      const submission =
        await FormSubmission.findById(submissionId).session(session);
      if (!submission) {
        return res.status(404).json({
          success: false,
          error: 'Submission not found',
        });
      }

      // Verify submission belongs to this form
      if (submission.formId.toString() !== form._id.toString()) {
        return res.status(400).json({
          success: false,
          error: 'Submission does not belong to this form',
        });
      }

      // Verify submission is in pending payment state
      if (submission.status !== 'pending_payment') {
        return res.status(400).json({
          success: false,
          error: `Submission is not in pending payment state. Current status: ${submission.status}`,
        });
      }

      // Find the payment field (get the first one if multiple exist)
      const paymentField = form.fields.find((f) => f.type === 'payment');
      if (!paymentField) {
        return res.status(400).json({
          success: false,
          error: 'Payment field not found',
        });
      }

      console.log('Processing form payment:', {
        formId: form._id,
        formTitle: form.title,
        submissionId: submission._id,
        fieldId: paymentField.id,
        fieldLabel: paymentField.label,
        email: email.substring(0, 5) + '...',
      });

      // Calculate amount based on pricing packages or fixed price
      let amount = 0;
      let packageInfo = null;
      let finalQuantity = parseInt(quantity) || 1;

      if (paymentField.paymentConfig?.pricingPackages?.length > 0) {
        // Pricing packages available
        if (selectedPackage) {
          // Use selected package
          const selectedPkg = paymentField.paymentConfig.pricingPackages.find(
            (pkg) => pkg.name === selectedPackage
          );

          if (!selectedPkg) {
            return res.status(400).json({
              success: false,
              error: 'Invalid package selected',
            });
          }

          packageInfo = {
            name: selectedPkg.name,
            description: selectedPkg.description,
            price: selectedPkg.price,
            quantity: finalQuantity,
            maxQuantity: selectedPkg.maxQuantity,
          };

          // Validate quantity
          if (
            selectedPkg.maxQuantity &&
            finalQuantity > selectedPkg.maxQuantity
          ) {
            return res.status(400).json({
              success: false,
              error: `Maximum quantity for this package is ${selectedPkg.maxQuantity}`,
            });
          }

          amount = selectedPkg.price * finalQuantity;
        } else {
          // Use default selected package
          const defaultPkg =
            paymentField.paymentConfig.pricingPackages.find(
              (pkg) => pkg.defaultSelected && pkg.isEnabled
            ) ||
            paymentField.paymentConfig.pricingPackages.find(
              (pkg) => pkg.isEnabled
            );

          if (defaultPkg) {
            packageInfo = {
              name: defaultPkg.name,
              description: defaultPkg.description,
              price: defaultPkg.price,
              quantity: finalQuantity,
              maxQuantity: defaultPkg.maxQuantity,
            };

            if (
              defaultPkg.maxQuantity &&
              finalQuantity > defaultPkg.maxQuantity
            ) {
              finalQuantity = defaultPkg.maxQuantity;
            }

            amount = defaultPkg.price * finalQuantity;
          } else {
            return res.status(400).json({
              success: false,
              error: 'No valid pricing package available',
            });
          }
        }
      } else {
        // Fixed price
        amount = paymentField.paymentConfig?.amount || 0;
      }

      if (amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid payment amount',
        });
      }

      console.log('Payment amount calculated:', {
        amount: amount,
        amountInDollars: amount / 100,
        package: packageInfo?.name,
        quantity: finalQuantity,
      });

      // Process payment with Square
      const paymentResult = await submitPayment(token, amount, {
        buyerEmailAddress: email,
        cardDetails: cardDetails || {
          last_4: '0000',
          card_brand: 'unknown',
          exp_month: '01',
          exp_year: '30',
        },
        metadata: {
          formId: form._id,
          formTitle: form.title,
          fieldId: paymentField.id,
          fieldLabel: paymentField.label,
          submissionId: submission._id,
          selectedPackage: packageInfo?.name,
          quantity: finalQuantity,
        },
      });

      // Update submission with payment data
      const paymentData = {
        paymentId: paymentResult.payment?.squareId || paymentResult.payment?.id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        squarePaymentId:
          paymentResult.payment?.squareId || paymentResult.payment?.id,
        receiptUrl: paymentResult.payment?.receiptUrl,
        cardLast4: cardDetails?.last_4 || '0000',
        cardBrand: cardDetails?.card_brand || 'unknown',
        timestamp: new Date(),
      };

      // Update submission data Map with payment info
      if (packageInfo) {
        submission.data.set('selectedPackage', packageInfo.name);
        submission.data.set('quantity', finalQuantity);
        paymentData.package = packageInfo.name;
        paymentData.quantity = finalQuantity;
      }

      submission.data.set(paymentField.name || paymentField.id, paymentData);

      // Update submission payment object
      submission.payment = {
        id: paymentResult.payment?.squareId || paymentResult.payment?.id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        gateway: 'square',
        transactionId:
          paymentResult.payment?.squareId || paymentResult.payment?.id,
        receiptUrl: paymentResult.payment?.receiptUrl,
        processedAt: new Date(),
        metadata: {
          fieldId: paymentField.id,
          fieldName: paymentField.name,
          cardLast4: cardDetails?.last_4 || '0000',
          cardBrand: cardDetails?.card_brand || 'unknown',
          selectedPackage: packageInfo,
        },
      };

      submission.status = 'completed';
      submission.completedAt = new Date();

      await submission.save({ session });

      // Send payment confirmation email
      if (email && paymentResult) {
        try {
          // Prepare the data for the receipt email
          const formData = {
            formTitle: form.title,
            userName: submission.userName || submission.data.get('name') || '',
            userEmail: email,
            amount: amount / 100,
            currency: paymentField.paymentConfig?.currency || 'USD',
            transactionId:
              paymentResult.payment?.squareId || paymentResult.payment?.id,
            receiptUrl: paymentResult.payment?.receiptUrl,
            selectedPackage: packageInfo,
            quantity: finalQuantity,
            tournamentInfo: form.tournamentSettings,
            venues: form.tournamentSettings?.venues || [],
            formData: submission.data.toObject(),
          };

          const submissionData = {
            submissionId: submission._id,
            submittedAt: submission.createdAt,
            cardLast4: cardDetails?.last_4 || '0000',
            cardBrand: cardDetails?.card_brand || 'unknown',
            paymentStatus: 'completed',
          };

          // Use the new form payment receipt email function
          await sendFormPaymentReceiptEmail(formData, submissionData);

          // Also send notification to form owner(s) if they have email notifications enabled
          if (form.settings?.sendEmail && form.settings?.emailTo?.length > 0) {
            const ownerEmails = form.settings.emailTo.filter(
              (email) => typeof email === 'string' && email.includes('@')
            );

            if (ownerEmails.length > 0) {
              try {
                const paymentDetails = packageInfo
                  ? `${packageInfo.name} (Quantity: ${finalQuantity})`
                  : 'Fixed price';

                // Send to each form owner email using the new helper function
                for (const ownerEmail of ownerEmails) {
                  await sendFormOwnerNotificationEmail({
                    to: ownerEmail,
                    formTitle: form.title,
                    customerName: submission.userName || 'N/A',
                    customerEmail: email,
                    amount: amount / 100,
                    currency: paymentField.paymentConfig?.currency || 'USD',
                    transactionId:
                      paymentResult.payment?.squareId ||
                      paymentResult.payment?.id,
                    submissionId: submission._id,
                    paymentDetails,
                    tournamentInfo: form.tournamentSettings,
                  });
                }
              } catch (ownerEmailError) {
                console.error(
                  'Error sending owner notification email:',
                  ownerEmailError
                );
              }
            }
          }
        } catch (emailError) {
          console.error('Error sending payment receipt email:', emailError);
          // Don't fail the payment if email fails - just log the error
        }
      }

      await session.commitTransaction();

      res.json({
        success: true,
        paymentId: paymentResult.payment?.squareId || paymentResult.payment?.id,
        squarePaymentId:
          paymentResult.payment?.squareId || paymentResult.payment?.id,
        receiptUrl: paymentResult.payment?.receiptUrl,
        submissionId: submission._id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        package: packageInfo,
        message: 'Payment processed successfully',
      });
    } catch (err) {
      await session.abortTransaction();
      console.error('Payment processing error:', err);
      res.status(400).json({
        success: false,
        error: err.message || 'Payment processing failed',
      });
    } finally {
      session.endSession();
    }
  }
);

// Keep the generic process-payment endpoint for backwards compatibility
router.post('/process-payment', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { token, fieldId, email, amount, cardDetails, formId, submissionId } =
      req.body;

    // Validate required fields
    if (!token || !amount || !email || !formId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required payment fields',
      });
    }

    // Get form to validate
    const form = await Form.findById(formId).session(session);
    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found',
      });
    }

    // Find payment field
    const paymentField = form.fields.find((f) =>
      fieldId ? f.id === fieldId && f.type === 'payment' : f.type === 'payment'
    );
    if (!paymentField) {
      return res.status(400).json({
        success: false,
        error: 'Payment field not found',
      });
    }

    let submission;
    let paymentResult;

    if (submissionId) {
      // Update existing submission (new multi-step flow)
      submission = await FormSubmission.findById(submissionId).session(session);
      if (!submission) {
        return res.status(404).json({
          success: false,
          error: 'Submission not found',
        });
      }

      // Verify submission belongs to this form
      if (submission.formId.toString() !== form._id.toString()) {
        return res.status(400).json({
          success: false,
          error: 'Submission does not belong to this form',
        });
      }

      paymentResult = await submitPayment(token, amount, {
        buyerEmailAddress: email,
        cardDetails: cardDetails || {
          last_4: '0000',
          card_brand: 'unknown',
          exp_month: '01',
          exp_year: '30',
        },
        metadata: {
          formId: form._id,
          formTitle: form.title,
          fieldId: paymentField.id,
          fieldLabel: paymentField.label,
          submissionId: submission._id,
        },
      });

      // Update submission with payment data
      const paymentData = {
        paymentId: paymentResult.payment?.squareId || paymentResult.payment?.id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        squarePaymentId:
          paymentResult.payment?.squareId || paymentResult.payment?.id,
        receiptUrl: paymentResult.payment?.receiptUrl,
        cardLast4: cardDetails?.last_4 || '0000',
        cardBrand: cardDetails?.card_brand || 'unknown',
        timestamp: new Date(),
      };

      submission.data.set(paymentField.name || paymentField.id, paymentData);

      submission.payment = {
        id: paymentResult.payment?.squareId || paymentResult.payment?.id,
        amount: amount / 100,
        currency: paymentField.paymentConfig?.currency || 'USD',
        status: 'completed',
        gateway: 'square',
        transactionId:
          paymentResult.payment?.squareId || paymentResult.payment?.id,
        receiptUrl: paymentResult.payment?.receiptUrl,
        processedAt: new Date(),
        metadata: {
          fieldId: paymentField.id,
          fieldName: paymentField.name,
          cardLast4: cardDetails?.last_4 || '0000',
          cardBrand: cardDetails?.card_brand || 'unknown',
        },
      };

      submission.status = 'completed';
      submission.completedAt = new Date();

      await submission.save({ session });
    } else {
      // Create new submission with just payment (legacy flow)
      paymentResult = await submitPayment(token, amount, {
        buyerEmailAddress: email,
        cardDetails: cardDetails || {
          last_4: '0000',
          card_brand: 'unknown',
          exp_month: '01',
          exp_year: '30',
        },
        metadata: {
          formId: form._id,
          formTitle: form.title,
          fieldId: paymentField.id,
          fieldLabel: paymentField.label,
        },
      });

      submission = new FormSubmission({
        formId: form._id,
        formVersion: form.version || 1,
        data: {
          [paymentField.name || paymentField.id]: {
            paymentId:
              paymentResult.payment?.squareId || paymentResult.payment?.id,
            amount: amount / 100,
            currency: paymentField.paymentConfig?.currency || 'USD',
            status: 'completed',
            squarePaymentId:
              paymentResult.payment?.squareId || paymentResult.payment?.id,
            receiptUrl: paymentResult.payment?.receiptUrl,
            cardLast4: cardDetails?.last_4 || '0000',
            cardBrand: cardDetails?.card_brand || 'unknown',
            timestamp: new Date(),
          },
        },
        payment: {
          id: paymentResult.payment?.squareId || paymentResult.payment?.id,
          amount: amount / 100,
          currency: paymentField.paymentConfig?.currency || 'USD',
          status: 'completed',
          gateway: 'square',
          transactionId:
            paymentResult.payment?.squareId || paymentResult.payment?.id,
          receiptUrl: paymentResult.payment?.receiptUrl,
          processedAt: new Date(),
          metadata: {
            fieldId: paymentField.id,
            fieldName: paymentField.name,
            cardLast4: cardDetails?.last_4 || '0000',
            cardBrand: cardDetails?.card_brand || 'unknown',
          },
        },
        userEmail: email,
        ipAddress:
          req.ip ||
          req.headers['x-forwarded-for'] ||
          req.connection.remoteAddress,
        userAgent: req.headers['user-agent'],
        referrer: req.headers['referer'] || req.headers['referrer'],
        metadata: req.body.metadata || {},
        status: 'completed',
        completedAt: new Date(),
      });

      await submission.save({ session });

      // Update form submission count
      form.submissions = (form.submissions || 0) + 1;
      await form.save({ session });
    }

    // Send payment confirmation email
    if (email && paymentResult) {
      try {
        await sendPaymentConfirmationEmail(form, submission, {
          amount: amount / 100,
          currency: paymentField.paymentConfig?.currency || 'USD',
          transactionId:
            paymentResult.payment?.squareId || paymentResult.payment?.id,
          receiptUrl: paymentResult.payment?.receiptUrl,
        });
      } catch (emailError) {
        console.error('Error sending payment confirmation email:', emailError);
      }
    }

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: paymentResult.payment?.squareId || paymentResult.payment?.id,
      squarePaymentId:
        paymentResult.payment?.squareId || paymentResult.payment?.id,
      receiptUrl: paymentResult.payment?.receiptUrl,
      submissionId: submission._id,
      amount: amount / 100,
      status: 'completed',
      message: 'Payment processed successfully',
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Payment processing error:', err);
    res.status(400).json({
      success: false,
      error: err.message || 'Payment processing failed',
    });
  } finally {
    session.endSession();
  }
});

// ========== EXISTING ROUTES (keep these as they are) ==========

// Get all forms with pagination and search
router.get('/', authenticate, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      search = '',
      sort = '-createdAt',
    } = req.query;
    const query = {
      $or: [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $regex: search, $options: 'i' } },
      ],
    };

    const forms = await Form.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .populate('createdBy', 'name email')
      .lean();

    const total = await Form.countDocuments(query);

    res.json({
      success: true,
      data: forms,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Error fetching forms:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch forms',
    });
  }
});

// Get single form by ID
router.get('/:id', async (req, res) => {
  try {
    const form = await Form.findById(req.params.id)
      .populate('createdBy', 'name email')
      .lean();

    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found',
      });
    }

    res.json({
      success: true,
      data: form,
    });
  } catch (err) {
    console.error('Error fetching form:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch form',
    });
  }
});

// Create new form
router.post('/', authenticate, validateForm, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array(),
    });
  }

  try {
    const form = new Form({
      ...req.body,
      createdBy: req.user.id,
    });

    await form.save();
    res.status(201).json({
      success: true,
      data: form,
    });
  } catch (err) {
    console.error('Error creating form:', err);
    res.status(400).json({
      success: false,
      error: 'Failed to create form',
    });
  }
});

// Update form
router.put('/:id', authenticate, validateForm, async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      errors: errors.array(),
    });
  }

  try {
    const form = await Form.findOneAndUpdate(
      { _id: req.params.id, createdBy: req.user.id },
      req.body,
      { new: true, runValidators: true }
    );

    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found or unauthorized',
      });
    }

    res.json({
      success: true,
      data: form,
    });
  } catch (err) {
    console.error('Error updating form:', err);
    res.status(400).json({
      success: false,
      error: 'Failed to update form',
    });
  }
});

// Delete form
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const form = await Form.findOneAndDelete({
      _id: req.params.id,
      createdBy: req.user.id,
    });

    if (!form) {
      return res.status(404).json({
        success: false,
        error: 'Form not found or unauthorized',
      });
    }

    await FormSubmission.deleteMany({ formId: req.params.id });

    res.json({
      success: true,
      message: 'Form and its submissions deleted successfully',
    });
  } catch (err) {
    console.error('Error deleting form:', err);
    res.status(400).json({
      success: false,
      error: 'Failed to delete form',
    });
  }
});

// Get form submissions with advanced filtering
router.get('/:id/submissions', authenticate, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 10,
      from,
      to,
      status,
      sort = '-submittedAt',
    } = req.query;

    const query = { formId: req.params.id };

    // Date range filter
    if (from || to) {
      query.submittedAt = {};
      if (from) query.submittedAt.$gte = new Date(from);
      if (to) query.submittedAt.$lte = new Date(to);
    }

    // Payment status filter
    if (status) {
      if (status === 'paid') {
        query['payment.status'] = 'COMPLETED';
      } else if (status === 'unpaid') {
        query['payment.status'] = { $ne: 'COMPLETED' };
      }
    }

    const submissions = await FormSubmission.find(query)
      .sort(sort)
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .populate('submittedBy', 'name email')
      .lean();

    const total = await FormSubmission.countDocuments(query);

    res.json({
      success: true,
      data: submissions,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) {
    console.error('Error fetching submissions:', err);
    res.status(400).json({
      success: false,
      error: 'Failed to fetch submissions',
    });
  }
});

module.exports = router;
