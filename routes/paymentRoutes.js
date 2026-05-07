// paymentRoutes.js
const express = require('express');
const {
  submitPayment,
  processRefund,
  getPaymentDetails,
} = require('../services/payment-wrapper');
const Payment = require('../models/Payment');
const {
  authenticate,
  isAdmin,
  canAccessPayment,
  canAccessParentData,
} = require('../utils/auth');
const router = express.Router();
const {
  syncRefundsForPayment,
  syncAllRefunds,
  syncRefundsByDateRange,
} = require('../services/syncRefunds');

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

// Process refund (ADMIN ONLY)
router.post('/refund', authenticate, isAdmin, async (req, res) => {
  console.log('🔄 ADMIN REFUND REQUEST RECEIVED');

  try {
    const { paymentId, amount, reason, parentId, refundAll = false } = req.body;

    console.log('📋 Request details:', {
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
      console.error('❌ Missing paymentId');
      return res.status(400).json({
        success: false,
        error: 'Payment ID is required',
      });
    }

    if (!amount || amount <= 0) {
      console.error('❌ Invalid amount:', amount);
      return res.status(400).json({
        success: false,
        error: 'Valid refund amount is required',
      });
    }

    console.log('🔍 Searching for payment...');

    // Try to find payment by either MongoDB _id OR Square paymentId
    let paymentRecord = null;

    // Check if it's a valid MongoDB ObjectId (24 hex characters)
    const isValidMongoId = /^[0-9a-fA-F]{24}$/.test(paymentId);

    if (isValidMongoId) {
      // Try to find by MongoDB _id
      console.log('🔍 Searching by MongoDB _id:', paymentId);
      paymentRecord = await Payment.findById(paymentId);
      console.log(
        '📊 MongoDB search result:',
        paymentRecord ? 'Found' : 'Not found',
      );
    }

    // If not found by _id, try by Square paymentId
    if (!paymentRecord) {
      console.log('🔍 Searching by Square paymentId:', paymentId);
      paymentRecord = await Payment.findOne({ paymentId: paymentId });
      console.log(
        '📊 Square search result:',
        paymentRecord ? 'Found' : 'Not found',
      );
    }

    if (!paymentRecord) {
      console.error('❌ Payment not found with any ID:', paymentId);
      return res.status(404).json({
        success: false,
        error: `Could not find payment with id: ${paymentId}`,
        message: 'Payment record not found in database',
      });
    }

    console.log('✅ Found payment record:', {
      mongoId: paymentRecord._id,
      squareId: paymentRecord.paymentId,
      amount: paymentRecord.amount,
      currentRefunds: paymentRecord.refunds?.length || 0,
      alreadyRefunded: paymentRecord.refundedAmount || 0,
      refundStatus: paymentRecord.refundStatus || 'none',
      parentId: paymentRecord.parentId,
    });

    // Validate that we have a Square payment ID
    if (!paymentRecord.paymentId) {
      console.error(
        '❌ No Square payment ID found for payment:',
        paymentRecord._id,
      );
      return res.status(400).json({
        success: false,
        error: 'Payment does not have a valid Square payment ID',
        message: 'Cannot process refund without Square payment ID',
      });
    }

    // Check if payment is already fully refunded
    if (
      paymentRecord.refundStatus === 'refunded' ||
      paymentRecord.refundStatus === 'full'
    ) {
      console.error('❌ Payment already fully refunded');
      return res.status(400).json({
        success: false,
        error: 'Payment has already been fully refunded',
        message: 'This payment cannot be refunded again',
      });
    }

    // Calculate available refund amount
    const alreadyRefunded = paymentRecord.refundedAmount || 0;
    const availableForRefund = paymentRecord.amount - alreadyRefunded;

    if (amount > availableForRefund) {
      console.error('❌ Refund amount exceeds available amount:', {
        requested: amount,
        available: availableForRefund,
        alreadyRefunded: alreadyRefunded,
      });
      return res.status(400).json({
        success: false,
        error: `Refund amount exceeds available balance`,
        message: `Maximum refundable amount: $${availableForRefund.toFixed(2)}`,
        availableAmount: availableForRefund,
      });
    }

    console.log('💰 Processing refund through Square...');

    // Now process the refund using the Square payment ID
    try {
      const result = await processRefund(paymentRecord.paymentId, amount, {
        reason: reason || 'Customer request',
        parentId: parentId || paymentRecord.parentId,
        refundAll,
      });

      console.log('✅ Refund processed successfully:', {
        adminId: req.user._id,
        adminEmail: req.user.email,
        refundId: result.refund?.id,
        amount: result.refund?.amount,
        status: result.refund?.status,
      });

      // Refresh the payment record to get updated data
      const updatedPayment = await Payment.findById(paymentRecord._id);

      res.json({
        success: true,
        message: 'Refund processed successfully',
        refund: result.refund,
        payment: {
          id: updatedPayment?._id,
          squareId: updatedPayment?.paymentId,
          refundedAmount: updatedPayment?.refundedAmount,
          refundStatus: updatedPayment?.refundStatus,
          availableForRefund: updatedPayment
            ? updatedPayment.amount - (updatedPayment.refundedAmount || 0)
            : 0,
        },
      });
    } catch (processError) {
      console.error('❌ Error in processRefund:', {
        message: processError.message,
        squareId: paymentRecord.paymentId,
        amount: amount,
      });

      // Re-throw the error to be caught by outer try-catch
      throw processError;
    }
  } catch (error) {
    console.error('❌ REFUND ROUTE ERROR:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      adminId: req.user._id,
      timestamp: new Date().toISOString(),
    });

    // Handle specific error messages
    let statusCode = 400;
    let errorMessage = error.message || 'Failed to process refund request';
    let userMessage = errorMessage;

    // Map specific error messages to user-friendly ones
    if (errorMessage.includes('already been refunded')) {
      userMessage = 'This payment has already been refunded.';
      statusCode = 400;
    } else if (errorMessage.includes('not found')) {
      userMessage =
        'Payment not found in Square system. Please check the payment ID.';
      statusCode = 404;
    } else if (errorMessage.includes('permission denied')) {
      userMessage =
        'Permission denied. Please check your Square API permissions.';
      statusCode = 403;
    } else if (errorMessage.includes('authentication')) {
      userMessage =
        'Square API authentication failed. Please check your access token.';
      statusCode = 401;
    } else if (errorMessage.includes('401')) {
      userMessage =
        'Square API authentication failed. Please check your access token.';
      statusCode = 401;
    } else if (errorMessage.includes('404')) {
      userMessage = 'Payment not found in Square system.';
      statusCode = 404;
    } else if (errorMessage.includes('timeout')) {
      userMessage = 'Request timed out. Please try again.';
      statusCode = 408;
    } else if (errorMessage.includes('network')) {
      userMessage =
        'Network error. Please check your connection and try again.';
      statusCode = 503;
    }

    res.status(statusCode).json({
      success: false,
      error: userMessage,
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString(),
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
  },
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
  },
);

// Get payments by parent ID with access control
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
        // ✅ Base payment includes paymentSystem and orderId for ALL users
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
          // ✅ ADD THESE - needed for receipt handling
          paymentSystem: payment.paymentSystem,
          orderId: payment.orderId,
        };

        // Only admins get full payment details (sensitive info)
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

        // Regular users and coaches get limited info (but still get paymentSystem and orderId)
        return basePayment;
      });

      console.log(
        `Returning ${sanitizedPayments.length} payments for parent ${parentId}`,
      );

      res.json(sanitizedPayments);
    } catch (error) {
      console.error('Error fetching payments by parent:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch payments',
      });
    }
  },
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

    // ✅ Ensure paymentSystem and orderId are included
    const paymentsWithSystem = payments.map((payment) => ({
      ...payment,
      paymentSystem: payment.paymentSystem,
      orderId: payment.orderId,
    }));

    const total = await Payment.countDocuments(filter);

    res.json({
      payments: paymentsWithSystem,
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

// Sync refunds for a specific payment - ADMIN ONLY
router.post(
  '/:paymentId/sync-refunds',
  authenticate,
  isAdmin,
  async (req, res) => {
    try {
      const { paymentId } = req.params;

      console.log('Manual refund sync requested for payment:', paymentId);

      const result = await syncRefundsForPayment(paymentId);

      if (result.success) {
        res.json({
          success: true,
          message: `Successfully synced ${result.refundsProcessed} refunds`,
          data: result,
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      console.error('Refund sync error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to sync refunds',
      });
    }
  },
);

// Sync all refunds - ADMIN ONLY
router.post('/sync/refunds', authenticate, isAdmin, async (req, res) => {
  try {
    console.log('Manual full refund sync requested by admin:', req.user._id);

    const result = await syncAllRefunds();

    if (result.success) {
      res.json({
        success: true,
        message: `Refund sync completed. Processed ${result.totalPaymentsProcessed} payments, synced ${result.totalRefundsSynced} refunds.`,
        data: result,
      });
    } else {
      res.status(400).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('Full refund sync error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to sync refunds',
    });
  }
});

// Sync refunds by date range - ADMIN ONLY
router.post(
  '/sync/refunds/by-date',
  authenticate,
  isAdmin,
  async (req, res) => {
    try {
      const { startDate, endDate } = req.body;

      if (!startDate || !endDate) {
        return res.status(400).json({
          success: false,
          error: 'Start date and end date are required',
        });
      }

      console.log('Date range refund sync requested:', { startDate, endDate });

      const result = await syncRefundsByDateRange(startDate, endDate);

      if (result.success) {
        res.json({
          success: true,
          message: `Date range sync completed: ${result.processed} processed, ${result.errors} errors`,
          data: result,
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      console.error('Date range refund sync error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to sync refunds by date range',
      });
    }
  },
);

module.exports = router;
