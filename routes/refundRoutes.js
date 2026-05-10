// routes/refundRoutes.js - COMPLETE FIXED VERSION
const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { sendEmail } = require('../utils/email');
const router = express.Router();
const { Client, Environment } = require('square');
const crypto = require('crypto');

// Create Square client for refund routes
const squareClient = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

const { refundsApi } = squareClient;

// POST /api/refunds/request
router.post('/request', authenticate, async (req, res) => {
  try {
    const { paymentId, reason, amount, notes } = req.body;
    const requestedBy = req.user.id;

    console.log('📋 Creating refund request:', { paymentId, amount, reason });

    // Find the payment
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
      });
    }

    // Validate refund amount
    const maxRefundable = payment.amount - (payment.totalRefunded || 0);
    if (amount > maxRefundable) {
      return res.status(400).json({
        success: false,
        error: `Refund amount exceeds available balance. Maximum refundable: $${maxRefundable.toFixed(2)}`,
      });
    }

    // Create refund request
    const refundRequest = {
      amount,
      reason: reason || 'Customer request',
      status: 'pending',
      requestedBy,
      requestedAt: new Date(),
      notes,
    };

    // Initialize refunds array if needed
    if (!payment.refunds) {
      payment.refunds = [];
    }

    payment.refunds.push(refundRequest);
    payment.refundStatus =
      (payment.totalRefunded || 0) + amount >= payment.amount
        ? 'requested'
        : 'partial';

    await payment.save();

    // Send notification to admin
    await sendRefundNotification(payment, refundRequest, req.user);

    res.json({
      success: true,
      message: 'Refund request submitted successfully',
      refundRequest: {
        ...refundRequest,
        _id: payment.refunds[payment.refunds.length - 1]._id, // Get the new refund ID
      },
    });
  } catch (error) {
    console.error('❌ Refund request error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to submit refund request',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// POST /api/refunds/process - COMPLETE FIXED VERSION
router.post('/process', authenticate, async (req, res) => {
  console.log('🔄 /refunds/process endpoint called');

  try {
    const { paymentId, refundId, action, adminNotes } = req.body;
    const processedBy = req.user.id;

    console.log('📋 Processing refund:', {
      paymentId,
      refundId,
      action,
      adminNotes,
      processedBy,
    });

    // Only admins can process refunds
    if (req.user.role !== 'admin') {
      console.error('❌ Unauthorized user:', req.user.role);
      return res.status(403).json({
        success: false,
        error: 'Unauthorized - Admin access required',
      });
    }

    // Validate required fields
    if (!paymentId || !refundId || !action) {
      console.error('❌ Missing required fields');
      return res.status(400).json({
        success: false,
        error:
          'Missing required fields: paymentId, refundId, and action are required',
      });
    }

    // Find the payment
    console.log('🔍 Looking for payment:', paymentId);
    const payment = await Payment.findById(paymentId);

    if (!payment) {
      console.error('❌ Payment not found');
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
      });
    }

    console.log('✅ Payment found:', {
      id: payment._id,
      squareId: payment.paymentId,
      amount: payment.amount,
    });

    // Find the refund request
    console.log('🔍 Looking for refund:', refundId);
    const refund = payment.refunds.id(refundId);

    if (!refund) {
      console.error('❌ Refund not found');
      console.log(
        'Available refunds:',
        payment.refunds?.map((r) => r._id),
      );
      return res.status(404).json({
        success: false,
        error: 'Refund request not found',
      });
    }

    console.log('✅ Refund found:', {
      id: refund._id,
      amount: refund.amount,
      status: refund.status,
      reason: refund.reason,
    });

    // Check if already processed
    if (refund.status !== 'pending') {
      console.error('❌ Refund already processed:', refund.status);
      return res.status(400).json({
        success: false,
        error: `Refund has already been ${refund.status}`,
      });
    }

    if (action === 'approve') {
      // Check for Square payment ID
      if (!payment.paymentId) {
        console.error('❌ Missing Square payment ID');
        return res.status(400).json({
          success: false,
          error: 'Payment missing Square payment ID',
        });
      }

      // Check Square access token
      if (!process.env.SQUARE_ACCESS_TOKEN) {
        console.error('❌ SQUARE_ACCESS_TOKEN not configured');
        return res.status(500).json({
          success: false,
          error: 'Payment system configuration error',
        });
      }

      console.log('💰 Processing Square refund for:', {
        squarePaymentId: payment.paymentId,
        amount: refund.amount,
        reason: refund.reason,
      });

      try {
        // Process refund with Square
        const refundResponse = await refundsApi.refundPayment({
          paymentId: payment.paymentId,
          idempotencyKey: `refund_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`,
          amountMoney: {
            amount: Math.round(refund.amount * 100), // Convert to cents
            currency: 'USD',
          },
          reason: refund.reason || adminNotes || 'Customer request',
        });

        // Validate Square response
        if (
          !refundResponse ||
          !refundResponse.result ||
          !refundResponse.result.refund
        ) {
          console.error('❌ Invalid Square response:', refundResponse);
          throw new Error('Invalid response from Square API');
        }

        const squareRefund = refundResponse.result.refund;

        console.log('✅ Square refund created:', {
          id: squareRefund.id,
          status: squareRefund.status,
          amount: squareRefund.amountMoney?.amount,
        });

        // Update refund record
        refund.status = 'completed';
        refund.squareRefundId = squareRefund.id;
        refund.processedAt = new Date();
        refund.refundedBy = processedBy;
        refund.notes = adminNotes || 'Approved via admin panel';

        // Update payment totals
        payment.totalRefunded = (payment.totalRefunded || 0) + refund.amount;
        payment.refundStatus =
          payment.totalRefunded >= payment.amount ? 'full' : 'partial';

        await payment.save();

        // Send confirmation email
        try {
          await sendRefundConfirmation(payment, refund);
          console.log('✅ Refund confirmation email sent');
        } catch (emailError) {
          console.warn('⚠️ Email sending failed:', emailError.message);
        }

        return res.json({
          success: true,
          message: 'Refund approved and processed successfully',
          refund: {
            _id: refund._id,
            amount: refund.amount,
            status: refund.status,
            squareRefundId: refund.squareRefundId,
            processedAt: refund.processedAt,
          },
        });
      } catch (squareError) {
        console.error('❌ Square API error:', {
          message: squareError.message,
          code: squareError.errors?.[0]?.code,
          detail: squareError.errors?.[0]?.detail,
        });

        // Mark refund as failed
        refund.status = 'failed';
        refund.notes = `Square error: ${squareError.errors?.[0]?.detail || squareError.message}`;
        refund.processedAt = new Date();
        await payment.save();

        let errorMessage = 'Failed to process refund with Square';

        if (squareError.errors && squareError.errors.length > 0) {
          const squareErr = squareError.errors[0];
          if (squareErr.code === 'UNAUTHORIZED') {
            errorMessage =
              'Square API authentication failed. Please check your access token.';
          } else if (squareErr.code === 'PAYMENT_NOT_FOUND') {
            errorMessage = 'Payment not found in Square system.';
          } else if (squareErr.code === 'REFUND_ALREADY_COMPLETED') {
            errorMessage = 'This payment has already been refunded.';
          } else if (squareErr.detail) {
            errorMessage = squareErr.detail;
          }
        }

        return res.status(400).json({
          success: false,
          error: errorMessage,
        });
      }
    } else if (action === 'reject') {
      // Handle rejection
      refund.status = 'failed';
      refund.notes = adminNotes || 'Refund rejected';
      refund.refundedBy = processedBy;
      refund.processedAt = new Date();

      await payment.save();

      return res.json({
        success: true,
        message: 'Refund rejected successfully',
        refund: {
          _id: refund._id,
          status: refund.status,
          notes: refund.notes,
          processedAt: refund.processedAt,
        },
      });
    } else {
      return res.status(400).json({
        success: false,
        error: 'Invalid action. Use "approve" or "reject"',
      });
    }
  } catch (error) {
    console.error('❌ Refund processing error:', {
      message: error.message,
      stack: error.stack,
      body: req.body,
    });

    return res.status(500).json({
      success: false,
      error: 'Internal server error processing refund',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// GET /api/refunds/all - Get all refunds with payment details
router.get('/all', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    // Get all payments that have refunds
    const paymentsWithRefunds = await Payment.aggregate([
      { $match: { 'refunds.0': { $exists: true } } },
      {
        $lookup: {
          from: 'users',
          localField: 'parentId',
          foreignField: '_id',
          as: 'parent',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'refunds.requestedBy',
          foreignField: '_id',
          as: 'requestedByUser',
        },
      },
      {
        $project: {
          'parent.fullName': 1,
          'parent.email': 1,
          'parent.phone': 1,
          amount: 1,
          totalRefunded: 1,
          refundedAmount: 1,
          refundStatus: 1,
          refunds: 1,
          'requestedByUser.fullName': 1,
          paymentId: 1,
          createdAt: 1,
          receiptUrl: 1,
          status: 1,
          cardLastFour: 1,
          cardBrand: 1,
          buyerEmail: 1,
        },
      },
      { $sort: { createdAt: -1 } },
    ]);

    console.log(`✅ Found ${paymentsWithRefunds.length} payments with refunds`);

    res.json(paymentsWithRefunds);
  } catch (error) {
    console.error('❌ Error fetching all refunds:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch refunds',
    });
  }
});

// GET /api/refunds/pending
router.get('/pending', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    const pendingRefunds = await Payment.aggregate([
      { $unwind: '$refunds' },
      { $match: { 'refunds.status': 'pending' } },
      {
        $lookup: {
          from: 'users',
          localField: 'parentId',
          foreignField: '_id',
          as: 'parent',
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'refunds.requestedBy',
          foreignField: '_id',
          as: 'requestedByUser',
        },
      },
      {
        $project: {
          'parent.fullName': 1,
          'parent.email': 1,
          'parent.phone': 1,
          amount: 1,
          totalRefunded: 1,
          refunds: 1,
          'requestedByUser.fullName': 1,
          paymentId: 1,
          createdAt: 1,
        },
      },
    ]);

    res.json(pendingRefunds);
  } catch (error) {
    console.error('❌ Error fetching pending refunds:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch pending refunds',
    });
  }
});

router.use('/process', authenticate, (req, res, next) => {
  // Only admins can process refunds
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Unauthorized - Admin access required',
    });
  }

  // Check Square configuration
  if (!process.env.SQUARE_ACCESS_TOKEN) {
    console.error('❌ SQUARE_ACCESS_TOKEN not configured');
    return res.status(500).json({
      success: false,
      error: 'Payment system configuration error',
    });
  }

  next();
});

// Email notification functions (keep these the same)
async function sendRefundNotification(payment, refundRequest, user) {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@bothellselect.com';

  await sendEmail({
    to: adminEmail,
    subject: 'New Refund Request - Bothell Select Basketball',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
        <h2 style="color: #dc2626;">⚠️ New Refund Request</h2>
        
        <div style="background: #fef2f2; padding: 15px; border-radius: 5px; border-left: 4px solid #dc2626;">
          <h3>Refund Details</h3>
          <p><strong>Requested By:</strong> ${user.fullName} (${user.email})</p>
          <p><strong>Original Payment:</strong> $${payment.amount}</p>
          <p><strong>Refund Amount:</strong> $${refundRequest.amount}</p>
          <p><strong>Reason:</strong> ${refundRequest.reason}</p>
          <p><strong>Notes:</strong> ${refundRequest.notes || 'N/A'}</p>
          <p><strong>Request Date:</strong> ${new Date(refundRequest.requestedAt).toLocaleDateString()}</p>
        </div>
        
        <p>Please review this refund request in the admin panel.</p>
        
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 5px;">
          <a href="${process.env.ADMIN_URL || 'https://bothellselect.com'}/admin/refunds" 
             style="background: #dc2626; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Review Refund Request
          </a>
        </div>
      </div>
    `,
  });
}

async function sendRefundConfirmation(payment, refund) {
  const Parent = require('../models/Parent');
  const parent = await Parent.findById(payment.parentId);

  if (!parent || !parent.email) return;

  await sendEmail({
    to: parent.email,
    subject: 'Refund Processed - Bothell Select Basketball',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
        <h2 style="color: #059669;">✅ Refund Processed</h2>
        
        <div style="background: #f0fdf4; padding: 15px; border-radius: 5px; border-left: 4px solid #059669;">
          <h3>Refund Confirmation</h3>
          <p><strong>Refund Amount:</strong> $${refund.amount}</p>
          <p><strong>Original Payment:</strong> $${payment.amount} on ${new Date(payment.createdAt).toLocaleDateString()}</p>
          <p><strong>Processed Date:</strong> ${new Date(refund.processedAt).toLocaleDateString()}</p>
          <p><strong>Notes:</strong> ${refund.notes || 'Refund processed successfully'}</p>
        </div>
        
        <p>The refund should appear on your original payment method within 5-10 business days.</p>
        
        <div style="margin-top: 20px; padding: 15px; background: #f8f9fa; border-radius: 5px;">
          <p>If you have any questions, please contact us at bothellselect@proton.me</p>
        </div>
      </div>
    `,
  });
}

module.exports = router;
