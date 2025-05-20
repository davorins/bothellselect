const express = require('express');
const router = express.Router();
const Form = require('../models/Form');
const FormSubmission = require('../models/FormSubmission');
const { authenticate } = require('../utils/auth');
const { submitPayment } = require('../services/square-payments');
const { body, validationResult } = require('express-validator');

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

// Submit form data
router.post(
  '/:id/submit',
  [body().isObject().withMessage('Submission data must be an object')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    try {
      const form = await Form.findById(req.params.id);
      if (!form) {
        return res.status(404).json({
          success: false,
          error: 'Form not found',
        });
      }

      // Validate required fields
      const missingFields = form.fields
        .filter((field) => field.required && !req.body[field.id])
        .map((field) => field.label || field.id);

      if (missingFields.length > 0) {
        return res.status(400).json({
          success: false,
          error: `Missing required fields: ${missingFields.join(', ')}`,
        });
      }

      const submissionData = {
        formId: form._id,
        data: req.body,
        submittedAt: new Date(),
        ipAddress: req.ip,
        ...(req.user?.id && { submittedBy: req.user.id }),
      };

      // Process payment if payment field exists
      const paymentField = form.fields.find((f) => f.type === 'payment');
      if (paymentField && req.body.paymentToken) {
        try {
          const paymentResult = await submitPayment(
            req.body.paymentToken,
            paymentField.paymentConfig.amount,
            {
              parentId: req.user?.id,
              buyerEmailAddress: req.body.email || req.user?.email,
              cardDetails: req.body.cardDetails || {},
            }
          );

          submissionData.payment = {
            id: paymentResult.payment.squareId,
            status: paymentResult.payment.status,
            amount: paymentField.paymentConfig.amount,
            currency: paymentField.paymentConfig.currency || 'USD',
            receiptUrl: paymentResult.payment.receiptUrl,
            processedAt: new Date(),
          };
        } catch (paymentError) {
          console.error('Payment processing error:', paymentError);
          return res.status(402).json({
            success: false,
            error: 'Payment processing failed',
            details: paymentError.message,
          });
        }
      }

      const submission = new FormSubmission(submissionData);
      await submission.save();

      res.status(201).json({
        success: true,
        data: submission,
      });
    } catch (err) {
      console.error('Form submission error:', err);
      res.status(400).json({
        success: false,
        error: 'Failed to submit form',
      });
    }
  }
);

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
