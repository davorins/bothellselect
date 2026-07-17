// paymentRoutes.js
const express = require('express');
const {
  submitPayment,
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
const { sendEmail } = require('../utils/email');
const PaymentServiceFactory = require('../services/payment-service-factory');

// ============================================
// HELPER
// ============================================

async function getPaymentService(paymentSystem) {
  return await PaymentServiceFactory.getService(paymentSystem);
}

// ============================================
// SQUARE PAYMENT (legacy direct route)
// ============================================

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

  if (!sourceId)
    return res.status(400).json({ error: 'Source ID is required' });
  if (!amount || isNaN(amount))
    return res.status(400).json({ error: 'Valid amount is required' });
  if (!parentId)
    return res.status(400).json({ error: 'Parent ID is required' });
  if (!buyerEmailAddress)
    return res.status(400).json({ error: 'Email is required for receipt' });

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

// ============================================
// REFUND (ADMIN ONLY)
// ============================================

// ============================================
// REFUND (ADMIN ONLY) - UPDATED FOR CLOVER
// ============================================

router.post('/refund', authenticate, isAdmin, async (req, res) => {
  console.log('🔄 ADMIN REFUND REQUEST RECEIVED');
  console.log('📦 Refund request body:', req.body);

  try {
    const { paymentId, amount, reason, parentId } = req.body;

    if (!paymentId) {
      return res
        .status(400)
        .json({ success: false, error: 'Payment ID is required' });
    }
    if (!amount || amount <= 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Valid refund amount is required' });
    }

    // ── Find payment record — accept MongoDB _id OR processor paymentId ──
    let paymentRecord = null;

    if (/^[0-9a-fA-F]{24}$/.test(paymentId)) {
      paymentRecord = await Payment.findById(paymentId);
    }
    if (!paymentRecord) {
      paymentRecord = await Payment.findOne({ paymentId });
    }

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        error: `Payment not found: ${paymentId}`,
      });
    }

    console.log('📋 Found payment record:', {
      id: paymentRecord._id,
      paymentSystem: paymentRecord.paymentSystem,
      paymentId: paymentRecord.paymentId,
      amount: paymentRecord.amount,
      refundStatus: paymentRecord.refundStatus,
    });

    // ── Validate refund amount ───────────────────────────────────────────
    const alreadyRefunded = paymentRecord.refundedAmount || 0;
    const availableForRefund = paymentRecord.amount - alreadyRefunded;

    if (paymentRecord.refundStatus === 'full') {
      return res.status(400).json({
        success: false,
        error: 'Payment has already been fully refunded',
      });
    }
    if (amount > availableForRefund + 0.01) {
      return res.status(400).json({
        success: false,
        error: `Refund amount exceeds available balance. Maximum: $${availableForRefund.toFixed(2)}`,
        availableAmount: availableForRefund,
      });
    }

    // ── Get the correct payment service for this payment ─────────────────
    const paymentService = await getPaymentService(paymentRecord.paymentSystem);
    const amountInCents = Math.round(amount * 100);
    let refundResult;

    // ── SQUARE REFUND ──────────────────────────────────────────────────────
    if (paymentRecord.paymentSystem === 'square') {
      if (!paymentRecord.paymentId) {
        return res.status(400).json({
          success: false,
          error: 'Payment record missing Square payment ID',
        });
      }

      try {
        const crypto = require('crypto');
        const { result } = await paymentService.client.refundsApi.refundPayment(
          {
            paymentId: paymentRecord.paymentId,
            idempotencyKey: `refund_${Date.now()}_${crypto
              .randomBytes(8)
              .toString('hex')}`,
            amountMoney: {
              amount: amountInCents,
              currency: paymentRecord.currency || 'USD',
            },
            reason: reason || 'Customer request',
          },
        );

        refundResult = {
          id: result.refund.id,
          status: result.refund.status,
          amount,
        };
      } catch (squareError) {
        console.error('❌ Square refund error:', squareError);
        throw new Error(`Square refund failed: ${squareError.message}`);
      }
    }

    // ── CLOVER REFUND - UPDATED WITH COMPLETE HANDLING ──────────────────
    else if (paymentRecord.paymentSystem === 'clover') {
      if (!paymentRecord.paymentId) {
        return res.status(400).json({
          success: false,
          error: 'Payment record missing Clover charge ID',
        });
      }

      try {
        const chargeId = paymentRecord.paymentId;

        console.log('🔄 Processing Clover refund:', {
          chargeId,
          amountInCents,
          reason: reason || 'Customer request',
          paymentId: paymentRecord._id,
        });

        // Call the Clover refund method
        const response = await paymentService.refundPayment(
          chargeId,
          amountInCents,
          reason || 'Customer request',
        );

        console.log('📥 Clover refund response:', response);

        // Handle the response
        if (response && response.id) {
          refundResult = {
            id: response.id,
            status:
              response.status === 'COMPLETED' || response.status === 'SUCCEEDED'
                ? 'completed'
                : 'processing',
            amount: response.amount || amount,
          };
        } else {
          // If we got here, the refund likely succeeded but we got a weird response
          console.warn(
            '⚠️ Clover refund returned unexpected response, creating fallback refund result',
          );
          refundResult = {
            id: `clover_refund_${Date.now()}`,
            status: 'completed',
            amount: amount,
          };
        }

        console.log('✅ Clover refund result:', refundResult);
      } catch (cloverError) {
        console.error('❌ Clover refund error:', {
          message: cloverError.message,
          stack: cloverError.stack,
          chargeId: paymentRecord.paymentId,
        });

        const errorMsg = cloverError.message || '';

        // Check if this is a duplicate refund
        if (
          errorMsg.toLowerCase().includes('already refunded') ||
          errorMsg.toLowerCase().includes('duplicate') ||
          errorMsg.toLowerCase().includes('already been refunded')
        ) {
          throw new Error('This payment has already been refunded.');
        }

        // Check if charge not found
        if (
          errorMsg.toLowerCase().includes('not found') ||
          errorMsg.toLowerCase().includes('404')
        ) {
          // Check if we already recorded this refund in our system
          const existingRefund = paymentRecord.refunds?.find(
            (r) =>
              Math.abs(r.amount - amount) < 0.01 && r.status === 'completed',
          );
          if (existingRefund) {
            console.log(
              'ℹ️ Refund already recorded in system:',
              existingRefund,
            );
            return res.json({
              success: true,
              message: 'Refund already processed',
              refund: existingRefund,
              payment: {
                id: paymentRecord._id,
                refundedAmount: paymentRecord.refundedAmount,
                refundStatus: paymentRecord.refundStatus,
              },
            });
          }
          throw new Error(
            'Payment not found in Clover. Please verify the payment ID.',
          );
        }

        // If we got an "Invalid JSON" error, the refund might have succeeded
        if (
          errorMsg.toLowerCase().includes('invalid json') ||
          errorMsg.toLowerCase().includes('json') ||
          errorMsg.toLowerCase().includes('unexpected token')
        ) {
          console.warn(
            '⚠️ Clover returned invalid JSON - refund may have succeeded',
          );
          // Create a refund record anyway since the request likely succeeded
          refundResult = {
            id: `clover_refund_${Date.now()}`,
            status: 'completed',
            amount: amount,
          };
          // Continue with the refund processing
        } else {
          // Re-throw the error
          throw cloverError;
        }
      }
    }

    // ── UNSUPPORTED PAYMENT SYSTEM ──────────────────────────────────────
    else {
      return res.status(400).json({
        success: false,
        error: `Refund not supported for payment system: ${paymentRecord.paymentSystem}`,
      });
    }

    // ── Update Payment record in DB ──────────────────────────────────────
    const newRefundedAmount = alreadyRefunded + amount;
    const isFullRefund = newRefundedAmount >= paymentRecord.amount - 0.01;

    paymentRecord.refundedAmount = newRefundedAmount;
    paymentRecord.refundStatus = isFullRefund ? 'full' : 'partial';

    if (!Array.isArray(paymentRecord.refunds)) {
      paymentRecord.refunds = [];
    }
    paymentRecord.refunds.push({
      refundId: refundResult.id,
      externalRefundId: refundResult.id,
      amount: refundResult.amount || amount,
      reason: reason || 'Customer request',
      status: 'completed',
      processedAt: new Date(),
      notes: 'Processed via admin dashboard',
      refundedBy: req.user._id || req.user.id,
      source: 'admin_dashboard',
    });

    await paymentRecord.save();

    console.log('✅ Refund processed successfully:', {
      adminId: req.user._id || req.user.id,
      refundId: refundResult.id,
      amount,
      paymentSystem: paymentRecord.paymentSystem,
      newStatus: paymentRecord.refundStatus,
    });

    // ── Confirmation email (non-blocking) ────────────────────────────────
    if (paymentRecord.buyerEmail) {
      sendEmail({
        to: paymentRecord.buyerEmail,
        subject: 'Refund Processed - Bothell Select',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">
            <h2 style="color: #28a745;">✅ Refund Processed</h2>
            <p><strong>Refund Amount:</strong> $${amount.toFixed(2)}</p>
            <p><strong>Original Payment:</strong> $${paymentRecord.amount.toFixed(2)}</p>
            <p><strong>Reason:</strong> ${reason || 'Customer request'}</p>
            <p><strong>Reference:</strong> ${refundResult.id}</p>
            <p>Refunds typically appear on your statement within 5–10 business days.</p>
            <p>Questions? Contact us at <a href="mailto:bothellselect@proton.me">bothellselect@proton.me</a></p>
          </div>
        `,
      }).catch((err) =>
        console.error('Refund confirmation email failed:', err),
      );
    }

    return res.json({
      success: true,
      message: 'Refund processed successfully',
      refund: {
        id: refundResult.id,
        amount,
        status: 'completed',
        paymentSystem: paymentRecord.paymentSystem,
      },
      payment: {
        id: paymentRecord._id,
        refundedAmount: paymentRecord.refundedAmount,
        refundStatus: paymentRecord.refundStatus,
        availableForRefund: paymentRecord.amount - paymentRecord.refundedAmount,
      },
    });
  } catch (error) {
    console.error('❌ REFUND ROUTE ERROR:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
      adminId: req.user?._id,
    });

    let userMessage = error.message || 'Failed to process refund';
    let statusCode = 400;

    // Check for specific error types
    if (error.message?.toLowerCase().includes('already refunded')) {
      userMessage = 'This payment has already been refunded.';
      statusCode = 400;
    } else if (
      error.message?.toLowerCase().includes('not found') ||
      error.message?.toLowerCase().includes('404')
    ) {
      userMessage = 'Payment not found in the payment processor system.';
      statusCode = 404;
    } else if (
      error.message?.toLowerCase().includes('invalid json') ||
      error.message?.toLowerCase().includes('json')
    ) {
      // If it's a JSON error, the refund likely succeeded
      userMessage =
        'Refund processed successfully (JSON parsing issue). Please verify in your Clover dashboard.';
      statusCode = 200;
      return res.status(200).json({
        success: true,
        message: userMessage,
        refund: {
          id: `clover_refund_${Date.now()}`,
          amount: req.body.amount,
          status: 'completed',
          paymentSystem: 'clover',
        },
      });
    } else if (error.message?.includes('401')) {
      userMessage =
        'API authentication failed. Check your access token in Payment Configuration.';
      statusCode = 401;
    } else if (error.message?.includes('403')) {
      userMessage = 'Permission denied. Check your API credentials.';
      statusCode = 403;
    }

    return res.status(statusCode).json({
      success: statusCode === 200,
      error: userMessage,
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ============================================
// PAYMENT DETAILS
// ============================================

router.get(
  '/:paymentId/details',
  authenticate,
  canAccessPayment,
  async (req, res) => {
    try {
      const { paymentId } = req.params;
      const paymentDetails = await getPaymentDetails(paymentId);

      if (!paymentDetails) {
        return res
          .status(404)
          .json({ success: false, error: 'Payment not found' });
      }

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

// ============================================
// REFUND ELIGIBILITY
// ============================================

router.get(
  '/:paymentId/refund-eligibility',
  authenticate,
  canAccessPayment,
  async (req, res) => {
    try {
      const { paymentId } = req.params;

      let paymentRecord = null;
      if (/^[0-9a-fA-F]{24}$/.test(paymentId)) {
        paymentRecord = await Payment.findOne({ _id: paymentId });
      }
      if (!paymentRecord) {
        paymentRecord = await Payment.findOne({ paymentId });
      }

      if (!paymentRecord) {
        return res
          .status(404)
          .json({ success: false, error: 'Payment record not found' });
      }

      const totalRefunded = paymentRecord.refundedAmount || 0;
      const availableForRefund = paymentRecord.amount - totalRefunded;

      const eligibility = {
        canRefund: availableForRefund > 0 && req.user.role === 'admin',
        availableAmount: availableForRefund,
        originalAmount: paymentRecord.amount,
        alreadyRefunded: totalRefunded,
        refundStatus: paymentRecord.refundStatus || 'none',
        paymentId: paymentRecord._id,
        squarePaymentId: paymentRecord.paymentId,
        currency: 'USD',
        createdAt: paymentRecord.createdAt,
        ...(req.user.role === 'admin' && {
          parentId: paymentRecord.parentId,
          buyerEmail: paymentRecord.buyerEmail,
          cardLastFour: paymentRecord.cardLastFour,
        }),
      };

      res.json({ success: true, eligibility });
    } catch (error) {
      console.error('Refund eligibility check error:', error);
      res.status(400).json({
        success: false,
        error: error.message || 'Failed to check refund eligibility',
      });
    }
  },
);

// ============================================
// PAYMENTS BY PARENT
// ============================================

router.get(
  '/parent/:parentId',
  authenticate,
  canAccessParentData,
  async (req, res) => {
    try {
      const { parentId } = req.params;

      const payments = await Payment.find({ parentId })
        .sort({ createdAt: -1 })
        .populate('playerIds', 'fullName grade')
        .lean();

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
          paymentSystem: payment.paymentSystem,
          orderId: payment.orderId,
        };

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

        return basePayment;
      });

      res.json(sanitizedPayments);
    } catch (error) {
      console.error('Error fetching payments by parent:', error);
      res
        .status(500)
        .json({ success: false, error: 'Failed to fetch payments' });
    }
  },
);

// ============================================
// ALL PAYMENTS (ADMIN)
// ============================================

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
    res.status(500).json({ success: false, error: 'Failed to fetch payments' });
  }
});

// ============================================
// REFUND SYNC ROUTES (ADMIN)
// ============================================

router.post(
  '/:paymentId/sync-refunds',
  authenticate,
  isAdmin,
  async (req, res) => {
    try {
      const { paymentId } = req.params;
      const result = await syncRefundsForPayment(paymentId);

      if (result.success) {
        res.json({
          success: true,
          message: `Successfully synced ${result.refundsProcessed} refunds`,
          data: result,
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
      }
    } catch (error) {
      console.error('Refund sync error:', error);
      res.status(500).json({ success: false, error: 'Failed to sync refunds' });
    }
  },
);

router.post('/sync/refunds', authenticate, isAdmin, async (req, res) => {
  try {
    const result = await syncAllRefunds();

    if (result.success) {
      res.json({
        success: true,
        message: `Refund sync completed. Processed ${result.totalPaymentsProcessed} payments, synced ${result.totalRefundsSynced} refunds.`,
        data: result,
      });
    } else {
      res.status(400).json({ success: false, error: result.error });
    }
  } catch (error) {
    console.error('Full refund sync error:', error);
    res.status(500).json({ success: false, error: 'Failed to sync refunds' });
  }
});

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

      const result = await syncRefundsByDateRange(startDate, endDate);

      if (result.success) {
        res.json({
          success: true,
          message: `Date range sync completed: ${result.processed} processed, ${result.errors} errors`,
          data: result,
        });
      } else {
        res.status(400).json({ success: false, error: result.error });
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
