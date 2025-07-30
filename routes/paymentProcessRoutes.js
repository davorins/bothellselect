// paymentProcessRoutes.js
const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { square } = require('../services/square-payments');
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
    body('amount')
      .isInt({ min: 1 })
      .withMessage('Amount must be a positive integer'),
    body('currency').isIn(['USD']).withMessage('Currency must be USD'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('players')
      .isArray({ min: 1 })
      .withMessage('At least one player is required'),
    body('players.*.playerId').isMongoId().withMessage('Invalid player ID'),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030'),
    body('players.*.tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array(), success: false });
    }

    const { token, amount, currency, email, players } = req.body;
    const session = await mongoose.startSession();

    try {
      await session.withTransaction(async () => {
        console.log('Starting payment transaction for:', email);

        // Verify the authenticated user
        const parent = await Parent.findOne({
          email: email.toLowerCase().trim(),
        }).session(session);
        if (!parent) {
          throw new Error('Parent not found');
        }

        if (parent._id.toString() !== req.user.id) {
          throw new Error(
            'Unauthorized: Email does not match authenticated user'
          );
        }

        // Validate players
        for (const player of players) {
          const existingPlayer = await Player.findById(player.playerId).session(
            session
          );
          if (!existingPlayer) {
            throw new Error(`Player not found: ${player.playerId}`);
          }
          if (existingPlayer.parentId.toString() !== parent._id.toString()) {
            throw new Error(
              `Player ${player.playerId} does not belong to this parent`
            );
          }
        }

        // Create Square customer
        const { result: customerResult } =
          await square.customersApi.createCustomer({
            emailAddress: email,
          });

        const customerId = customerResult.customer?.id;
        if (!customerId) {
          throw new Error('Failed to create customer');
        }

        // Process payment with Square
        const paymentRequest = {
          sourceId: token,
          amountMoney: {
            amount: amount,
            currency,
          },
          idempotencyKey: crypto.randomUUID(),
          locationId: process.env.SQUARE_LOCATION_ID,
          customerId,
          referenceId: `parent:${parent._id}`,
          note: `Tryout payment for ${players.length} player(s)`,
        };

        console.log('Processing Square payment with request:', paymentRequest);
        const paymentResponse =
          await square.paymentsApi.createPayment(paymentRequest);
        const paymentResult = paymentResponse.result.payment;
        console.log('Square payment response:', paymentResult);

        if (paymentResult.status !== 'COMPLETED') {
          throw new Error(
            `Payment failed with status: ${paymentResult.status}`
          );
        }

        // Create Payment record
        const payment = new Payment({
          parentId: parent._id,
          playerCount: players.length,
          paymentId: paymentResult.id,
          locationId: process.env.SQUARE_LOCATION_ID,
          buyerEmail: email,
          cardLastFour: paymentResult.cardDetails.card.last4,
          cardBrand: paymentResult.cardDetails.card.cardBrand,
          cardExpMonth: paymentResult.cardDetails.card.expMonth,
          cardExpYear: paymentResult.cardDetails.card.expYear,
          amount: amount / 100,
          currency,
          status: 'completed',
          processedAt: new Date(),
          receiptUrl: paymentResult.receiptUrl,
          players: players.map((p) => ({
            playerId: p.playerId,
            season: p.season,
            year: p.year,
            tryoutId: p.tryoutId || null,
          })),
        });

        await payment.save({ session });

        // Update Player seasons
        for (const player of players) {
          await Player.updateOne(
            { _id: player.playerId },
            {
              $push: {
                seasons: {
                  season: player.season,
                  year: player.year,
                  tryoutId: player.tryoutId || null,
                  paymentStatus: 'paid',
                  paymentComplete: true,
                  paymentId: paymentResult.id,
                  amountPaid: amount / 100 / players.length,
                  cardLast4: paymentResult.cardDetails.card.last4,
                  cardBrand: paymentResult.cardDetails.card.cardBrand,
                },
              },
              $set: {
                paymentComplete: true,
                paymentStatus: 'paid',
              },
            },
            { session }
          );
        }

        // Update Registration records
        const registrationUpdates = await Registration.updateMany(
          {
            player: { $in: players.map((p) => p.playerId) },
            season: { $in: players.map((p) => p.season) },
            year: { $in: players.map((p) => p.year) },
            tryoutId: { $in: players.map((p) => p.tryoutId || null) },
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentDate: new Date(),
            },
          },
          { session }
        );

        console.log('Updated registrations:', registrationUpdates);

        // Update Parent
        await Parent.findByIdAndUpdate(
          parent._id,
          { $set: { paymentComplete: true, updatedAt: new Date() } },
          { session }
        );

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
                <p><strong>Payment ID:</strong> ${paymentResult.id}</p>
                <p><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
                <p>
                  <strong>Receipt:</strong>
                  <a href="${paymentResult.receiptUrl}" target="_blank">
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

        res.status(200).json({
          success: true,
          paymentId: payment._id,
          parentUpdated: true,
          playersUpdated: players.length,
          playerIds: players.map((p) => p.playerId),
          status: 'processed',
        });
      });
    } catch (error) {
      console.error('Payment processing error:', {
        message: error.message,
        stack: error.stack,
        requestBody: req.body,
      });
      res.status(400).json({
        success: false,
        error: 'Tryout payment processing failed',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;
