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
    body('players.*.playerId')
      .optional()
      .custom((value) => !value || mongoose.Types.ObjectId.isValid(value))
      .withMessage('Invalid player ID format'),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030'),
    body('players.*.tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'),
    body('cardDetails').isObject().withMessage('Card details are required'),
    body('cardDetails.last_4')
      .isLength({ min: 4, max: 4 })
      .withMessage('Invalid card last 4 digits'),
    body('cardDetails.card_brand')
      .notEmpty()
      .withMessage('Card brand is required'),
    body('cardDetails.exp_month')
      .isInt({ min: 1, max: 12 })
      .withMessage('Invalid expiration month'),
    body('cardDetails.exp_year')
      .isInt({ min: new Date().getFullYear() })
      .withMessage('Invalid expiration year'),
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
      const { token, sourceId, amount, currency, email, players, cardDetails } =
        req.body;

      // Verify parent exists
      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        throw new Error('Parent not found');
      }

      // Get all player IDs from the request
      const playerIds = players
        .map((p) => p.playerId)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id));

      // Verify all players belong to this parent
      const playerRecords = await Player.find({
        _id: { $in: playerIds },
        parentId: parent._id,
      }).session(session);

      if (playerRecords.length !== playerIds.length) {
        throw new Error(
          'One or more players not found or do not belong to this parent'
        );
      }

      // Create or retrieve Square customer
      let customerId = parent.squareCustomerId;
      if (!customerId) {
        const { result: customerResult } =
          await client.customersApi.createCustomer({
            emailAddress: email,
            givenName: parent.fullName.split(' ')[0],
            familyName: parent.fullName.split(' ').slice(1).join(' '),
          });

        if (!customerResult.customer?.id) {
          throw new Error('Failed to create customer');
        }

        customerId = customerResult.customer.id;
        parent.squareCustomerId = customerId;
        await parent.save({ session });
      }

      // Process payment with Square
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: parseInt(amount),
          currency: currency,
        },
        idempotencyKey: crypto.randomUUID(),
        locationId: process.env.SQUARE_LOCATION_ID,
        customerId,
        referenceId: `parent:${parent._id}`,
        note: `Tryout payment for ${players.length} player(s)`,
        buyerEmailAddress: email,
      };

      const paymentResponse =
        await client.paymentsApi.createPayment(paymentRequest);
      const paymentResult = paymentResponse.result.payment;

      if (paymentResult.status !== 'COMPLETED') {
        throw new Error(`Payment failed with status: ${paymentResult.status}`);
      }

      // Create Payment record with playerIds
      const payment = new Payment({
        parentId: parent._id,
        playerIds: playerRecords.map((p) => p._id), // Include playerIds
        playerCount: players.length,
        paymentId: paymentResult.id,
        locationId: process.env.SQUARE_LOCATION_ID,
        buyerEmail: email,
        cardLastFour: cardDetails.last_4,
        cardBrand: cardDetails.card_brand,
        cardExpMonth: cardDetails.exp_month,
        cardExpYear: cardDetails.exp_year,
        amount: amount / 100,
        currency,
        status: 'completed',
        processedAt: new Date(),
        receiptUrl: paymentResult.receiptUrl,
        players: players.map((p) => ({
          playerId: p.playerId || null,
          season: p.season,
          year: p.year,
          tryoutId: p.tryoutId || null,
        })),
      });

      await payment.save({ session });

      // Update Parent payment status
      await Parent.findByIdAndUpdate(
        parent._id,
        { $set: { paymentComplete: true, updatedAt: new Date() } },
        { session }
      );

      // Update Player seasons and top-level payment status
      const perPlayerAmount = amount / 100 / players.length;
      const updatedPlayers = [];

      for (const player of playerRecords) {
        const seasonData = {
          season: players[0].season,
          year: players[0].year,
          tryoutId: players[0].tryoutId || null,
          registrationDate: new Date(),
          paymentStatus: 'paid',
          paymentComplete: true,
          paymentId: paymentResult.id,
          amountPaid: perPlayerAmount,
          cardLast4: cardDetails.last_4,
          cardBrand: cardDetails.card_brand,
          paymentDate: new Date(),
        };

        // Find the matching season to update
        const seasonIndex = player.seasons.findIndex(
          (s) =>
            s.season === seasonData.season &&
            s.year === seasonData.year &&
            (s.tryoutId === seasonData.tryoutId ||
              (!s.tryoutId && !seasonData.tryoutId))
        );

        if (seasonIndex === -1) {
          player.seasons.push(seasonData);
        } else {
          player.seasons[seasonIndex] = {
            ...player.seasons[seasonIndex],
            ...seasonData,
          };
        }

        // Update player document with top-level payment status
        const updatedPlayer = await Player.findByIdAndUpdate(
          player._id,
          {
            $set: {
              seasons: player.seasons,
              paymentComplete: true, // Update top-level field
              paymentStatus: 'paid', // Update top-level field
              updatedAt: new Date(),
            },
          },
          { new: true, session }
        );

        // Update registration records
        await Registration.updateMany(
          {
            player: player._id,
            season: seasonData.season,
            year: seasonData.year,
            tryoutId: seasonData.tryoutId || null,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentDate: new Date(),
              paymentId: paymentResult.id,
            },
          },
          { session }
        );

        updatedPlayers.push(updatedPlayer);
      }

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

      await session.commitTransaction();

      res.status(200).json({
        success: true,
        paymentId: payment._id,
        parentUpdated: true,
        playersUpdated: updatedPlayers.length,
        playerIds: updatedPlayers.map((p) => p._id.toString()),
        players: updatedPlayers.map((p) => ({
          _id: p._id,
          fullName: p.fullName,
          seasons: p.seasons,
          paymentComplete: p.paymentComplete,
          paymentStatus: p.paymentStatus,
        })),
        status: 'processed',
        receiptUrl: paymentResult.receiptUrl,
      });
    } catch (error) {
      await session.abortTransaction();
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
