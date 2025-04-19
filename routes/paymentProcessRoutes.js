const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { square } = require('../services/square-payments');
const router = express.Router();
const mongoose = require('mongoose');
const Parent = require('../models/Parent');
const Player = require('../models/Player');

// POST /api/payments/process
router.post('/process', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { sourceId, amount, parentId, playerCount, cardDetails, locationId } =
      req.body;

    // Validate parent exists
    const parentExists = await Parent.findById(parentId).session(session);
    if (!parentExists) {
      throw new Error('Parent not found');
    }

    // Process payment with Square
    const paymentResponse = await square.paymentsApi.createPayment({
      sourceId,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: require('crypto').randomBytes(32).toString('hex'),
      locationId,
    });

    if (paymentResponse.result.payment?.status !== 'COMPLETED') {
      throw new Error(
        `Payment failed with status: ${paymentResponse.result.payment?.status}`
      );
    }

    // Create payment record
    const payment = new Payment({
      parentId,
      playerCount,
      paymentId: paymentResponse.result.payment.id,
      locationId,
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

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: payment._id,
      parentUpdated: true,
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

// POST /api/payments/update-players
router.post('/update-players', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { parentId } = req.body;

    // Validate parent exists
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      throw new Error('Parent not found');
    }

    // Find all players for this parent
    const players = await Player.find({ parentId }).session(session);
    if (players.length === 0) {
      throw new Error('No players found for this parent');
    }

    const playerIds = players.map((player) => player._id);

    // Update all players in a transaction
    const updateResult = await Player.updateMany(
      { _id: { $in: playerIds } },
      { $set: { paymentComplete: true } },
      { session }
    );

    await session.commitTransaction();

    res.json({
      success: true,
      playersUpdated: updateResult.modifiedCount,
      playerIds: playerIds,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Player update failed:', error.message);
    res.status(400).json({
      success: false,
      error: 'Player update failed',
      details: error.message,
    });
  } finally {
    session.endSession();
  }
});

// Check payment status
router.get('/status/:paymentId', authenticate, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.paymentId);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    res.json({ status: payment.status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
