const express = require('express');
const {
  submitPayment,
  processRefund,
  getPaymentDetails,
} = require('../services/square-payments');
const Payment = require('../models/Payment');
const router = express.Router();

// Process payment
router.post('/square-payment', async (req, res) => {
  const {
    sourceId,
    amount,
    parentId,
    playerId,
    buyerEmailAddress,
    cardDetails,
    locationId,
  } = req.body;

  // Validate required fields
  if (!sourceId)
    return res.status(400).json({ error: 'Source ID is required' });
  if (!amount || isNaN(amount))
    return res.status(400).json({ error: 'Valid amount is required' });
  if (!parentId)
    return res.status(400).json({ error: 'Parent ID is required' });
  if (!buyerEmailAddress) {
    return res.status(400).json({ error: 'Email is required for receipt' });
  }

  try {
    const result = await submitPayment(sourceId, amount, {
      parentId,
      playerId,
      buyerEmailAddress,
      cardDetails,
      locationId,
    });

    res.json(result);
  } catch (error) {
    console.error('Payment error:', error);
    res.status(500).json({
      error: error.message || 'Payment failed',
      details: error.errors,
    });
  }
});

// Process refund
router.post('/refund', async (req, res) => {
  try {
    const { paymentId, amount, reason, parentId, refundAll = false } = req.body;

    console.log('Refund request received:', {
      paymentId,
      amount,
      reason,
      parentId,
      refundAll,
    });

    // Validate required fields
    if (!paymentId) {
      return res.status(400).json({
        success: false,
        error: 'Payment ID is required',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid refund amount is required',
      });
    }

    const result = await processRefund(paymentId, amount, {
      reason: reason || 'Customer request',
      parentId,
      refundAll,
    });

    console.log('Refund processed successfully:', result);

    res.json({
      success: true,
      message: 'Refund processed successfully',
      refund: result.refund,
    });
  } catch (error) {
    console.error('Refund route error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });

    // Handle specific Square errors
    if (error.message.includes('already been refunded')) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        error: error.message,
      });
    }

    if (
      error.message.includes('permission denied') ||
      error.message.includes('Square refund processing failed')
    ) {
      return res.status(403).json({
        success: false,
        error: error.message,
      });
    }

    res.status(400).json({
      success: false,
      error: error.message || 'Failed to process refund request',
    });
  }
});

// Get payment details for refund validation
router.get('/:paymentId/details', async (req, res) => {
  try {
    const { paymentId } = req.params;

    console.log('Getting payment details for:', paymentId);

    const paymentDetails = await getPaymentDetails(paymentId);

    res.json({
      success: true,
      payment: paymentDetails,
    });
  } catch (error) {
    console.error('Get payment details error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to get payment details',
    });
  }
});

// Check refund eligibility
router.get('/:paymentId/refund-eligibility', async (req, res) => {
  try {
    const { paymentId } = req.params;

    console.log('Checking refund eligibility for payment:', paymentId);

    // First, try to find the payment by MongoDB ID
    let paymentRecord = await Payment.findOne({ _id: paymentId });

    // If not found by MongoDB ID, try by Square payment ID
    if (!paymentRecord) {
      paymentRecord = await Payment.findOne({ paymentId: paymentId });
    }

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        error: 'Payment record not found',
      });
    }

    // Calculate refund eligibility
    const totalRefunded = paymentRecord.refundedAmount || 0;
    const availableForRefund = paymentRecord.amount - totalRefunded;

    const eligibility = {
      canRefund: availableForRefund > 0,
      availableAmount: availableForRefund,
      originalAmount: paymentRecord.amount,
      alreadyRefunded: totalRefunded,
      refundStatus: paymentRecord.refundStatus || 'none',
      paymentId: paymentRecord._id,
      squarePaymentId: paymentRecord.paymentId,
      currency: 'USD',
      createdAt: paymentRecord.createdAt,
    };

    console.log('Refund eligibility result:', eligibility);

    res.json({
      success: true,
      eligibility,
    });
  } catch (error) {
    console.error('Refund eligibility check error:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to check refund eligibility',
    });
  }
});

module.exports = router;
