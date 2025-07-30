const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { square } = require('../services/square-payments');
const router = express.Router();
const mongoose = require('mongoose');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const { sendEmail } = require('../utils/email');
const crypto = require('crypto');

// POST /api/payments/process
router.post('/process', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      sourceId,
      amount,
      parentId,
      playerCount,
      cardDetails,
      locationId,
      buyerEmailAddress,
    } = req.body;

    if (!buyerEmailAddress) {
      throw new Error('Email is required for payment receipt');
    }

    const parentExists = await Parent.findById(parentId).session(session);
    if (!parentExists) {
      throw new Error('Parent not found');
    }

    const { result: customerResult } = await square.customersApi.createCustomer(
      {
        emailAddress: buyerEmailAddress,
      }
    );

    const customerId = customerResult.customer?.id;
    if (!customerId) {
      throw new Error('Failed to create customer');
    }

    const paymentRequest = {
      sourceId,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: crypto.randomBytes(32).toString('hex'),
      locationId,
      customerId,
      referenceId: `parent:${parentId}`,
      note: `Payment for ${playerCount} player(s)`,
    };

    const paymentResponse =
      await square.paymentsApi.createPayment(paymentRequest);

    if (paymentResponse.result.payment?.status !== 'COMPLETED') {
      throw new Error(
        `Payment failed with status: ${paymentResponse.result.payment?.status}`
      );
    }

    const payment = new Payment({
      parentId,
      playerCount,
      paymentId: paymentResponse.result.payment.id,
      locationId,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand,
      cardExpMonth: cardDetails.exp_month,
      cardExpYear: cardDetails.exp_year,
      amount: amount / 100,
      currency: 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResponse.result.payment?.receiptUrl,
    });

    await payment.save({ session });

    // Update parent payment status
    await Parent.updateOne(
      { _id: parentId },
      { $set: { paymentComplete: true } },
      { session }
    );

    // Update all related players' payment status
    const players = await Player.find({ parentId }).session(session);
    if (players.length === 0) {
      throw new Error('No players found for this parent');
    }

    const playerIds = players.map((player) => player._id);
    const updateResult = await Player.updateMany(
      { _id: { $in: playerIds } },
      { $set: { paymentComplete: true } },
      { session }
    );

    // Send email receipt
    await sendEmail({
      to: buyerEmailAddress,
      subject: 'Your Bothell Select Payment Receipt',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
          <h2 style="color: #2c3e50;">Thank you for your payment!</h2>
          <p style="font-size: 16px;">We’ve successfully processed your payment for <strong>${playerCount}</strong> player(s).</p>

          <hr style="margin: 20px 0;" />

          <p><strong>Amount Paid:</strong> $${(amount / 100).toFixed(2)}</p>
          <p><strong>Payment ID:</strong> ${paymentResponse.result.payment.id}</p>
          <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>

          <p>
            <strong>Receipt:</strong>
            <a href="${paymentResponse.result.payment?.receiptUrl}" target="_blank">
              View your payment receipt
            </a>
          </p>

          <hr style="margin: 20px 0;" />

          <p style="font-size: 14px; color: #555;">If you have any questions, feel free to reply to this email.</p>
          <p style="font-size: 14px; color: #555;">– Bothell Select Team</p>
        </div>
      `,
    });

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: payment._id,
      parentUpdated: true,
      playersUpdated: updateResult.modifiedCount,
      playerIds,
      status: 'processed',
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment processing failed:', error.message);
    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      details: error.message,
    });
  } finally {
    session.endSession();
  }
});

module.exports = router;
