// paymentProcessRoutes.js
const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { client } = require('../services/square-payments');
const router = express.Router();
const mongoose = require('mongoose');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Registration = require('../models/Registration');
const { sendEmail } = require('../utils/email');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');

// POST /api/payments/process
router.post('/process', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      sourceId,
      amount,
      parentId,
      playerIds,
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

    // Get all player records
    const playerRecords = await Player.find({
      _id: { $in: playerIds },
      parentId: parentId,
    }).session(session);

    if (playerRecords.length === 0) {
      throw new Error('No valid players found for this payment');
    }

    const { result: customerResult } = await client.customersApi.createCustomer(
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
      await client.paymentsApi.createPayment(paymentRequest);

    if (paymentResponse.result.payment?.status !== 'COMPLETED') {
      throw new Error(
        `Payment failed with status: ${paymentResponse.result.payment?.status}`
      );
    }

    const payment = new Payment({
      parentId,
      playerIds: playerRecords.map((p) => p._id),
      playerCount: playerRecords.length,
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
    const updateResult = await Player.updateMany(
      { _id: { $in: playerIds } },
      { $set: { paymentComplete: true } },
      { session }
    );

    // Send email receipt
    try {
      await sendEmail({
        to: buyerEmailAddress,
        subject: 'Your Payment Receipt',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
            <h2 style="color: #2c3e50;">Thank you for your payment!</h2>
            <p style="font-size: 16px;">We've successfully processed your payment for <strong>${playerCount}</strong> player(s).</p>
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
          </div>
        `,
      });
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
    }

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
    console.error('Payment processing failed:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
    });
    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  } finally {
    session.endSession();
  }
});

// POST /api/payments/tryout
router.post(
  '/tryout',
  authenticate,
  [
    body('token').notEmpty().withMessage('Payment token is required'),
    body('amount').isInt({ min: 1 }).withMessage('Valid amount is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('players')
      .isArray({ min: 1 })
      .withMessage('At least one player is required'),
    body('players.*.playerId')
      .optional()
      .isMongoId()
      .withMessage('Invalid player ID'),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .isInt({ min: 2020 })
      .withMessage('Valid year is required'),
    body('players.*.tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be string'),
    body('cardDetails').isObject().withMessage('Card details are required'),
    body('cardDetails.last_4')
      .isLength({ min: 4, max: 4 })
      .withMessage('Invalid card last 4'),
    body('cardDetails.card_brand')
      .notEmpty()
      .withMessage('Card brand is required'),
    body('cardDetails.exp_month')
      .isInt({ min: 1, max: 12 })
      .withMessage('Invalid exp month'),
    body('cardDetails.exp_year')
      .isInt({ min: new Date().getFullYear() })
      .withMessage('Invalid exp year'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: 'Validation failed',
      });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const { token, amount, email, players, cardDetails } = req.body;
      const parentId = req.user.id;

      // 1. Validate parent exists
      const parent = await Parent.findById(parentId).session(session);
      if (!parent) {
        throw new Error('Parent not found');
      }

      // 2. Process payment with Square
      const paymentRequest = {
        sourceId: token,
        amountMoney: { amount: parseInt(amount), currency: 'USD' },
        idempotencyKey: crypto.randomUUID(),
        locationId: process.env.SQUARE_LOCATION_ID,
        referenceId: `parent:${parentId}`,
        note: `Tryout payment for ${players.length} player(s)`,
        buyerEmailAddress: email,
      };

      const { result } = await client.paymentsApi.createPayment(paymentRequest);
      const squarePayment = result.payment;

      if (!squarePayment || squarePayment.status !== 'COMPLETED') {
        throw new Error(`Payment failed with status: ${squarePayment?.status}`);
      }

      // 3. Create payment record
      const paymentRecord = new Payment({
        parentId,
        playerIds: players.map((p) => p.playerId),
        paymentId: squarePayment.id,
        amount: amount / 100,
        status: squarePayment.status.toLowerCase(),
        receiptUrl: squarePayment.receiptUrl,
        cardLastFour: cardDetails.last_4,
        cardBrand: cardDetails.card_brand,
        cardExpMonth: cardDetails.exp_month,
        cardExpYear: cardDetails.exp_year,
        buyerEmail: email,
        players: players.map((p) => ({
          playerId: p.playerId,
          season: p.season,
          year: p.year,
          tryoutId: p.tryoutId,
        })),
      });

      await paymentRecord.save({ session });

      // 4. Update all related documents in parallel
      const updateOperations = [
        // Update parent
        Parent.updateOne(
          { _id: parentId },
          {
            $set: {
              paymentComplete: true,
              lastPaymentDate: new Date(),
            },
            $push: { payments: paymentRecord._id },
          },
          { session }
        ),

        // Update players
        Player.updateMany(
          { _id: { $in: players.map((p) => p.playerId) } },
          {
            $set: {
              paymentComplete: true,
              paymentStatus: 'paid',
            },
            $push: {
              seasons: {
                season: players[0].season,
                year: players[0].year,
                tryoutId: players[0].tryoutId,
                paymentStatus: 'paid',
                paymentDate: new Date(),
                paymentId: paymentRecord._id,
              },
              payments: paymentRecord._id,
            },
          },
          { session }
        ),

        // Update registrations
        Registration.updateMany(
          {
            player: { $in: players.map((p) => p.playerId) },
            season: players[0].season,
            year: players[0].year,
            tryoutId: players[0].tryoutId,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentDate: new Date(),
              paymentId: paymentRecord._id,
            },
          },
          { session }
        ),
      ];

      await Promise.all(updateOperations);

      // Send email receipt
      try {
        await sendEmail({
          to: email,
          subject: 'Your Tryout Payment Receipt',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
              <h2 style="color: #2c3e50;">Thank you for your tryout payment!</h2>
              <p style="font-size: 16px;">We've successfully processed your payment for <strong>${players.length}</strong> player(s).</p>
              <hr style="margin: 20px 0;" />
              <p><strong>Amount Paid:</strong> $${(amount / 100).toFixed(2)}</p>
              <p><strong>Payment ID:</strong> ${squarePayment.id}</p>
              <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
              <p>
                <strong>Receipt:</strong>
                <a href="${squarePayment.receiptUrl}" target="_blank">
                  View your payment receipt
                </a>
              </p>
              <hr style="margin: 20px 0;" />
              <p style="font-size: 14px; color: #555;">If you have any questions, feel free to reply to this email.</p>
            </div>
          `,
        });
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
      }

      // 6. Commit transaction
      await session.commitTransaction();

      // 7. Return updated player data
      const updatedPlayers = await Player.find({
        _id: { $in: players.map((p) => p.playerId) },
      }).session(session);

      res.json({
        success: true,
        paymentId: paymentRecord._id,
        receiptUrl: squarePayment.receiptUrl,
        players: updatedPlayers.map((p) => ({
          _id: p._id,
          fullName: p.fullName,
          paymentComplete: p.paymentComplete,
          paymentStatus: p.paymentStatus,
          seasons: p.seasons,
        })),
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Payment processing failed:', {
        error: error.message,
        stack: error.stack,
        requestBody: req.body,
      });
      res.status(400).json({
        success: false,
        error: error.message || 'Payment processing failed',
      });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;
