const express = require('express');
const {
  submitPayment,
  processRefund,
  getPaymentDetails,
} = require('../services/square-payments');
const Payment = require('../models/Payment');
const {
  authenticate,
  isAdmin,
  canAccessPayment,
  canAccessParentData,
} = require('../utils/auth');
const router = express.Router();

// Process payment - users can only process their own payments
router.post('/square-payment', authenticate, async (req, res) => {
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

  // ACCESS CONTROL: Users can only process payments for themselves
  if (req.user.role !== 'admin' && req.user._id.toString() !== parentId) {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized to process payment for this parent',
    });
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
      success: false,
      error: error.message || 'Payment failed',
      details: error.errors,
    });
  }
});

// Process refund - ADMIN ONLY
router.post('/refund', authenticate, isAdmin, async (req, res) => {
  try {
    const { paymentId, amount, reason, parentId, refundAll = false } = req.body;

    console.log('Admin refund request received:', {
      paymentId,
      amount,
      reason,
      parentId,
      refundAll,
      adminId: req.user._id,
      adminEmail: req.user.email,
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

    console.log('Refund processed successfully by admin:', {
      adminId: req.user._id,
      adminEmail: req.user.email,
      result,
    });

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
      adminId: req.user._id,
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

// Get payment details with access control
router.get(
  '/:paymentId/details',
  authenticate,
  canAccessPayment,
  async (req, res) => {
    try {
      const { paymentId } = req.params;

      console.log('Getting payment details for:', paymentId);

      const paymentDetails = await getPaymentDetails(paymentId);

      if (!paymentDetails) {
        return res.status(404).json({
          success: false,
          error: 'Payment not found',
        });
      }

      // Filter sensitive data based on role
      let responseData = {
        success: true,
        payment: {
          _id: paymentDetails._id,
          amount: paymentDetails.amount,
          createdAt: paymentDetails.createdAt,
          status: paymentDetails.status,
          receiptUrl: paymentDetails.receiptUrl,
          refundedAmount: paymentDetails.refundedAmount,
          refundStatus: paymentDetails.refundStatus,
          refunds: paymentDetails.refunds,
          playerIds: paymentDetails.playerIds,
        },
      };

      // Only admins get full payment details
      if (req.user.role === 'admin') {
        responseData.payment = {
          ...responseData.payment,
          paymentId: paymentDetails.paymentId,
          cardBrand: paymentDetails.cardBrand,
          cardLastFour: paymentDetails.cardLastFour,
          buyerEmail: paymentDetails.buyerEmail,
          parentId: paymentDetails.parentId,
        };
      }

      res.json(responseData);
    } catch (error) {
      console.error('Get payment details error:', error);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to get payment details',
      });
    }
  }
);

// Check refund eligibility with access control
router.get(
  '/:paymentId/refund-eligibility',
  authenticate,
  canAccessPayment,
  async (req, res) => {
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
        canRefund: availableForRefund > 0 && req.user.role === 'admin', // Only admins can actually refund
        availableAmount: availableForRefund,
        originalAmount: paymentRecord.amount,
        alreadyRefunded: totalRefunded,
        refundStatus: paymentRecord.refundStatus || 'none',
        paymentId: paymentRecord._id,
        squarePaymentId: paymentRecord.paymentId,
        currency: 'USD',
        createdAt: paymentRecord.createdAt,
        // Only include sensitive info for admins
        ...(req.user.role === 'admin' && {
          parentId: paymentRecord.parentId,
          buyerEmail: paymentRecord.buyerEmail,
          cardLastFour: paymentRecord.cardLastFour,
        }),
      };

      console.log('Refund eligibility result:', {
        eligibility,
        requestedBy: req.user._id,
        role: req.user.role,
        isCoach: req.user.isCoach,
      });

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
  }
);

// Get payments by parent ID with access control
router.get(
  '/parent/:parentId',
  authenticate,
  canAccessParentData,
  async (req, res) => {
    try {
      const { parentId } = req.params;

      console.log('Fetching payments for parent:', {
        parentId,
        requestedBy: req.user._id,
        role: req.user.role,
        isCoach: req.user.isCoach,
      });

      const payments = await Payment.find({ parentId })
        .sort({ createdAt: -1 })
        .populate('playerIds', 'fullName grade')
        .lean();

      // Filter sensitive data based on role
      const sanitizedPayments = payments.map((payment) => {
        const basePayment = {
          _id: payment._id,
          amount: payment.amount,
          createdAt: payment.createdAt,
          status: payment.status,
          receiptUrl: payment.receiptUrl,
          refundedAmount: payment.refundedAmount,
          refundStatus: payment.refundStatus,
          refunds: payment.refunds,
          playerIds: payment.playerIds,
          playerCount: payment.playerCount,
        };

        // Only admins get full payment details
        if (req.user.role === 'admin') {
          return {
            ...basePayment,
            paymentId: payment.paymentId,
            cardBrand: payment.cardBrand,
            cardLastFour: payment.cardLastFour,
            buyerEmail: payment.buyerEmail,
            parentId: payment.parentId,
          };
        }

        // Regular users and coaches get limited info
        return basePayment;
      });

      console.log(
        `Returning ${sanitizedPayments.length} payments for parent ${parentId}`
      );

      res.json(sanitizedPayments);
    } catch (error) {
      console.error('Error fetching payments by parent:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch payments',
      });
    }
  }
);

// Get all payments - ADMIN ONLY
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, parentId, status } = req.query;

    const filter = {};
    if (parentId) filter.parentId = parentId;
    if (status) filter.status = status;

    const payments = await Payment.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('parentId', 'fullName email phone')
      .populate('playerIds', 'fullName grade')
      .lean();

    const total = await Payment.countDocuments(filter);

    res.json({
      payments,
      totalPages: Math.ceil(total / limit),
      currentPage: page,
      total,
    });
  } catch (error) {
    console.error('Error fetching all payments:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch payments',
    });
  }
});

module.exports = router;
