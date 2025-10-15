// routes/refundRoutes.js
const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { client } = require('../services/square-payments');
const { sendEmail } = require('../utils/email');
const router = express.Router();

// POST /api/refunds/request
router.post('/request', authenticate, async (req, res) => {
  try {
    const { paymentId, reason, amount, notes } = req.body;
    const requestedBy = req.user.id;

    // Find the payment
    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Validate refund amount
    const maxRefundable = payment.amount - payment.totalRefunded;
    if (amount > maxRefundable) {
      return res.status(400).json({
        error: `Refund amount exceeds available balance. Maximum refundable: $${maxRefundable}`,
      });
    }

    // Create refund request
    const refundRequest = {
      refundId: `refund_req_${Date.now()}`,
      amount,
      reason: reason || 'Customer request',
      status: 'pending',
      requestedBy,
      requestedAt: new Date(),
      notes,
    };

    payment.refunds.push(refundRequest);
    payment.refundStatus =
      payment.totalRefunded + amount >= payment.amount
        ? 'requested'
        : 'partial';

    await payment.save();

    // Send notification to admin
    await sendRefundNotification(payment, refundRequest, req.user);

    res.json({
      success: true,
      message: 'Refund request submitted successfully',
      refundRequest,
    });
  } catch (error) {
    console.error('Refund request error:', error);
    res.status(500).json({ error: 'Failed to submit refund request' });
  }
});

// POST /api/refunds/process
router.post('/process', authenticate, async (req, res) => {
  try {
    const { paymentId, refundId, action, adminNotes } = req.body;
    const processedBy = req.user.id;

    // Only admins can process refunds
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const payment = await Payment.findById(paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    const refund = payment.refunds.id(refundId);
    if (!refund) {
      return res.status(404).json({ error: 'Refund request not found' });
    }

    if (action === 'approve') {
      // Process refund with Square
      const refundResponse = await client.refundsApi.refundPayment({
        paymentId: payment.paymentId,
        idempotencyKey: `refund_${Date.now()}`,
        amountMoney: {
          amount: Math.round(refund.amount * 100), // Convert to cents
          currency: 'USD',
        },
        reason: refund.reason,
      });

      const squareRefund = refundResponse.result.refund;

      // Update refund status
      refund.status = 'completed';
      refund.refundId = squareRefund.id; // Square refund ID
      refund.processedAt = new Date();
      refund.refundedBy = processedBy;
      refund.notes = adminNotes;

      // Update payment totals
      payment.totalRefunded += refund.amount;
      payment.refundStatus =
        payment.totalRefunded >= payment.amount ? 'full' : 'partial';

      await payment.save();

      // Send confirmation email to parent
      await sendRefundConfirmation(payment, refund);
    } else if (action === 'reject') {
      refund.status = 'failed';
      refund.notes = adminNotes || 'Refund rejected';
      refund.refundedBy = processedBy;

      payment.refundStatus = payment.totalRefunded > 0 ? 'partial' : 'none';
      await payment.save();
    }

    res.json({
      success: true,
      message: `Refund ${action}d successfully`,
      refund,
    });
  } catch (error) {
    console.error('Refund processing error:', error);
    res.status(500).json({ error: 'Failed to process refund' });
  }
});

// GET /api/refunds/pending
router.get('/pending', authenticate, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Unauthorized' });
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
    console.error('Error fetching pending refunds:', error);
    res.status(500).json({ error: 'Failed to fetch pending refunds' });
  }
});

// Email notification functions
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
          <a href="${process.env.ADMIN_URL}/refunds" 
             style="background: #dc2626; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">
            Review Refund Request
          </a>
        </div>
      </div>
    `,
  });
}

async function sendRefundConfirmation(payment, refund) {
  // Get parent email (you might need to populate this differently)
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
