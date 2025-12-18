// routes/form-payments.js
const express = require('express');
const router = express.Router();
const { processFormPayment } = require('../services/form-payments');
const FormSubmission = require('../models/FormSubmission');
const crypto = require('crypto');

// Process form payment
router.post('/process', async (req, res) => {
  try {
    const {
      token,
      sourceId,
      amount,
      currency,
      email,
      formId,
      fieldId,
      submissionId,
      description,
      cardDetails,
      metadata,
    } = req.body;

    console.log('Processing form payment:', {
      formId,
      fieldId,
      amount,
      email: email?.substring(0, 5) + '...',
    });

    // Validate required fields
    if (!token && !sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid amount is required',
      });
    }

    if (!formId) {
      return res.status(400).json({
        success: false,
        error: 'Form ID is required',
      });
    }

    // Process payment with Square
    const paymentResult = await processFormPayment(
      sourceId || token,
      amount,
      currency || 'USD',
      {
        formId,
        submissionId: submissionId || crypto.randomUUID(),
        fieldId,
        buyerEmail: email,
        description,
      }
    );

    console.log('Square payment result:', {
      paymentId: paymentResult.payment.id,
      status: paymentResult.payment.status,
      amount: paymentResult.payment.amountMoney?.amount,
    });

    // Save or update form submission
    let submission;
    if (submissionId) {
      // Update existing submission
      submission = await FormSubmission.findOneAndUpdate(
        { _id: submissionId },
        {
          $set: {
            'data.$[elem].value': {
              paymentId: paymentResult.payment.id,
              amount: amount / 100,
              currency: currency || 'USD',
              status: paymentResult.payment.status,
              cardLast4: cardDetails?.last_4,
              cardBrand: cardDetails?.card_brand,
              timestamp: new Date(),
            },
            paymentStatus: 'paid',
            updatedAt: new Date(),
          },
        },
        {
          arrayFilters: [{ 'elem.fieldId': fieldId }],
          new: true,
        }
      );
    } else {
      // Create new submission
      submission = new FormSubmission({
        formId,
        data: [
          {
            fieldId,
            value: {
              paymentId: paymentResult.payment.id,
              amount: amount / 100,
              currency: currency || 'USD',
              status: paymentResult.payment.status,
              cardLast4: cardDetails?.last_4,
              cardBrand: cardDetails?.card_brand,
              timestamp: new Date(),
            },
          },
        ],
        paymentStatus: 'paid',
        buyerEmail: email,
        metadata: metadata || {},
      });
      await submission.save();
    }

    res.json({
      success: true,
      paymentId: paymentResult.payment.id,
      squarePaymentId: paymentResult.payment.id,
      receiptUrl: paymentResult.payment.receiptUrl,
      submissionId: submission._id,
      message: 'Payment processed successfully',
    });
  } catch (error) {
    console.error('Form payment processing error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Payment processing failed',
    });
  }
});

// Verify payment status
router.get('/verify/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;

    // You would typically verify with Square API here
    // For now, return mock data
    res.json({
      success: true,
      paymentId,
      status: 'completed',
      verified: true,
    });
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(400).json({
      success: false,
      error: 'Payment verification failed',
    });
  }
});

module.exports = router;
