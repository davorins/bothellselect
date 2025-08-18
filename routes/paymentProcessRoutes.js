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
      players, // Array of players with season/year/tryoutId
      cardDetails,
      locationId,
      email: buyerEmailAddress,
      token,
    } = req.body;

    // Use authenticated user's ID
    const parentId = req.user.id;
    if (!parentId) {
      throw new Error('Parent ID not found in authentication token');
    }

    // Get parent with session
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    // Get player records
    const playerIds = players.map((p) => p.playerId).filter((id) => id);
    const playerRecords = await Player.find({
      _id: { $in: playerIds },
      parentId: parent._id,
    }).session(session);

    if (playerRecords.length === 0) {
      throw new Error('No valid players found for this payment');
    }

    // Use existing Square customer ID or create new one
    let customerId = parent.squareCustomerId;
    if (!customerId) {
      const { result: customerResult } =
        await client.customersApi.createCustomer({
          emailAddress: buyerEmailAddress,
          referenceId: `parent:${parent._id}`,
        });
      customerId = customerResult.customer?.id;

      // Update parent with new customer ID
      await Parent.updateOne(
        { _id: parentId },
        { $set: { squareCustomerId: customerId } },
        { session }
      );
    }

    // Process payment
    const paymentRequest = {
      sourceId: sourceId || token,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: crypto.randomUUID(),
      locationId: locationId || process.env.SQUARE_LOCATION_ID,
      customerId,
      referenceId: `parent:${parent._id}`,
      note: `Payment for ${players.length} player(s)`,
      buyerEmailAddress,
      autocomplete: true,
    };

    const { result } = await client.paymentsApi.createPayment(paymentRequest);
    const paymentResult = result.payment;

    if (!paymentResult || paymentResult.status !== 'COMPLETED') {
      throw new Error(
        `Payment failed with status: ${paymentResult?.status || 'unknown'}`
      );
    }

    // Create Payment record
    const payment = new Payment({
      parentId: parent._id,
      playerIds: playerRecords.map((p) => p._id),
      playerCount: players.length,
      paymentId: paymentResult.id,
      locationId: paymentRequest.locationId,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand,
      cardExpMonth: cardDetails.exp_month,
      cardExpYear: cardDetails.exp_year,
      amount: amount / 100,
      currency: 'USD',
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

    // Update players and registrations
    const updatedPlayers = [];
    for (const player of playerRecords) {
      try {
        const playerRequest = players.find(
          (p) => p.playerId === player._id.toString()
        );
        if (!playerRequest) continue;

        // Find matching season or create new one
        const seasonIndex = player.seasons.findIndex(
          (s) =>
            s.season === playerRequest.season &&
            s.year === playerRequest.year &&
            (s.tryoutId === playerRequest.tryoutId ||
              (!s.tryoutId && !playerRequest.tryoutId))
        );

        const seasonData = {
          season: playerRequest.season,
          year: playerRequest.year,
          tryoutId: playerRequest.tryoutId || null,
          paymentStatus: 'paid',
          paymentComplete: true,
          paymentId: paymentResult.id,
          amountPaid: amount / 100 / players.length,
          cardLast4: cardDetails.last_4,
          cardBrand: cardDetails.card_brand,
          paymentDate: new Date(),
        };

        if (seasonIndex >= 0) {
          player.seasons[seasonIndex] = {
            ...player.seasons[seasonIndex],
            ...seasonData,
          };
        } else {
          player.seasons.push({ ...seasonData, registrationDate: new Date() });
        }

        // Force update
        player.markModified('seasons');
        const updatedPlayer = await player.save({ session });
        updatedPlayers.push(updatedPlayer);

        // NEW: Update registrations - similar to /tryout
        await Registration.updateMany(
          {
            player: player._id,
            season: playerRequest.season,
            year: playerRequest.year,
            tryoutId: playerRequest.tryoutId || null,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentDate: new Date(),
              paymentId: paymentResult.id,
              updatedAt: new Date(),
            },
          },
          { session }
        );
      } catch (updateError) {
        console.error(`Failed to update player ${player._id}:`, updateError);
        throw new Error(`Failed to update player ${player.fullName}`);
      }
    }

    // Update parent
    await Parent.updateOne(
      { _id: parentId },
      { $set: { paymentComplete: true } },
      { session }
    );

    // Send receipt email
    try {
      await sendEmail({
        to: buyerEmailAddress,
        subject: 'Your Payment Receipt',
        html: `...`, // Your existing email template
      });
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
    }

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: payment._id,
      parentUpdated: true,
      playersUpdated: updatedPlayers.length,
      playerIds: updatedPlayers.map((p) => p._id.toString()),
      players: updatedPlayers.map((p) => ({
        _id: p._id,
        fullName: p.fullName,
        seasons: p.seasons.map((s) => ({
          season: s.season,
          year: s.year,
          tryoutId: s.tryoutId,
          paymentStatus: s.paymentStatus,
          paymentComplete: s.paymentComplete,
        })),
      })),
      status: 'processed',
      receiptUrl: paymentResult.receiptUrl,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment processing failed:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
      user: req.user,
    });
    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
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
      .notEmpty()
      .custom((value) => mongoose.Types.ObjectId.isValid(value))
      .withMessage('Valid playerId is required'),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030'),
    body('players.*.tryoutId')
      .notEmpty()
      .isString()
      .withMessage('Tryout ID is required and must be a string'),
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
      console.log('Validation errors:', errors.array());
      const errorMessages = errors.array().map((err) => err.msg);
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: `Validation failed: ${errorMessages.join(', ')}`,
      });
    }

    const { token, sourceId, amount, currency, email, players, cardDetails } =
      req.body;
    const perPlayerAmount = amount / 100 / players.length;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Log incoming payment data
      console.log('Payment data received:', {
        parentId: req.user.id,
        playerIds: players.map((p) => p.playerId),
        season: players[0]?.season,
        year: players[0]?.year,
        tryoutId: players[0]?.tryoutId,
        amount: amount / 100,
        playerCount: players.length,
      });

      // Verify parent exists
      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        console.error('Parent not found:', { parentId: req.user.id });
        throw new Error('Parent not found');
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
        customerId: parent.squareCustomerId,
        referenceId: `parent:${parent._id}`,
        note: `Tryout payment for ${players.length} player(s)`,
        buyerEmailAddress: email,
      };

      console.log('Initiating Square payment:', {
        amount: amount / 100,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
      });

      const paymentResponse =
        await client.paymentsApi.createPayment(paymentRequest);
      const paymentResult = paymentResponse.result.payment;

      if (paymentResult.status !== 'COMPLETED') {
        console.error('Payment failed:', {
          status: paymentResult.status,
          paymentId: paymentResult.id,
        });
        throw new Error(`Payment failed with status: ${paymentResult.status}`);
      }

      // Create Payment record
      const payment = new Payment({
        parentId: parent._id,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
        paymentId: paymentResult.id,
        locationId: process.env.SQUARE_LOCATION_ID,
        buyerEmail: email,
        cardLastFour: cardDetails.last_4 || '',
        cardBrand: cardDetails.card_brand || '',
        cardExpMonth: cardDetails.exp_month,
        cardExpYear: cardDetails.exp_year,
        amount: amount / 100,
        currency,
        status: 'completed',
        processedAt: new Date(),
        receiptUrl: paymentResult.receiptUrl,
        players: players.map((p) => ({
          playerId: p.playerId,
          season: p.season.trim(),
          year: p.year,
          tryoutId: p.tryoutId.trim(),
        })),
      });

      await payment.save({ session });

      // Update all players and their seasons
      const updatedPlayers = [];
      for (const playerData of players) {
        const normalizedSeason = playerData.season.trim();
        const normalizedTryoutId = playerData.tryoutId.trim();

        // Find player by playerId
        let player;
        if (
          playerData.playerId &&
          mongoose.Types.ObjectId.isValid(playerData.playerId)
        ) {
          player = await Player.findOne({
            _id: playerData.playerId,
            parentId: parent._id,
          }).session(session);
        }

        if (!player) {
          console.error('Player not found:', {
            playerId: playerData.playerId,
            parentId: parent._id,
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
          });
          throw new Error(`Player not found for ID: ${playerData.playerId}`);
        }

        console.log('Processing player update:', {
          playerId: player._id,
          fullName: player.fullName,
          existingSeasons: player.seasons.map((s) => ({
            season: s.season,
            year: s.year,
            tryoutId: s.tryoutId,
            paymentStatus: s.paymentStatus,
          })),
          updateData: {
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
          },
        });

        // Find matching season
        const seasonIndex = player.seasons.findIndex(
          (s) =>
            s.season.trim().toLowerCase() === normalizedSeason.toLowerCase() &&
            s.year === playerData.year &&
            s.tryoutId.trim().toLowerCase() === normalizedTryoutId.toLowerCase()
        );

        const seasonData = {
          season: normalizedSeason,
          year: playerData.year,
          tryoutId: normalizedTryoutId,
          paymentStatus: 'paid',
          paymentComplete: true,
          paymentId: paymentResult.id,
          amountPaid: perPlayerAmount,
          cardLast4: cardDetails.last_4 || '',
          cardBrand: cardDetails.card_brand || '',
          paymentDate: new Date(),
          registrationDate:
            seasonIndex >= 0
              ? player.seasons[seasonIndex].registrationDate
              : new Date(),
        };

        if (seasonIndex >= 0) {
          // Update existing season
          player.seasons[seasonIndex] = seasonData;
        } else {
          // Add new season
          player.seasons.push(seasonData);
        }

        // Update top-level player fields
        player.paymentStatus = 'paid';
        player.paymentComplete = true;
        player.registrationComplete = true;
        player.lastPaymentDate = new Date();
        player.markModified('seasons');

        const updatedPlayer = await player.save({ session });
        console.log('Updated player:', {
          playerId: updatedPlayer._id,
          fullName: updatedPlayer.fullName,
          paymentStatus: updatedPlayer.paymentStatus,
          paymentComplete: updatedPlayer.paymentComplete,
          registrationComplete: updatedPlayer.registrationComplete,
          seasons: updatedPlayer.seasons.find(
            (s) =>
              s.season.trim().toLowerCase() ===
                normalizedSeason.toLowerCase() &&
              s.year === playerData.year &&
              s.tryoutId.trim().toLowerCase() ===
                normalizedTryoutId.toLowerCase()
          ),
        });
        updatedPlayers.push(updatedPlayer);

        // Update or create registration
        const registrationUpdate = await Registration.findOneAndUpdate(
          {
            player: updatedPlayer._id,
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            parent: parent._id,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentId: paymentResult.id,
              amountPaid: perPlayerAmount,
              cardLast4: cardDetails.last_4 || '',
              cardBrand: cardDetails.card_brand || '',
              paymentDate: new Date(),
              registrationComplete: true,
              updatedAt: new Date(),
              parent: parent._id,
            },
          },
          { upsert: true, new: true, session }
        );
        console.log('Updated/created registration:', {
          registrationId: registrationUpdate._id,
          playerId: updatedPlayer._id,
          fullName: updatedPlayer.fullName,
          season: normalizedSeason,
          year: playerData.year,
          tryoutId: normalizedTryoutId,
          paymentStatus: registrationUpdate.paymentStatus,
          paymentComplete: registrationUpdate.paymentComplete,
          registrationComplete: registrationUpdate.registrationComplete,
          paymentId: registrationUpdate.paymentId,
          paymentDate: registrationUpdate.paymentDate,
        });
      }

      // Update parent
      const allRegistrations = await Registration.find({
        parent: parent._id,
        season: players[0].season,
        year: players[0].year,
        tryoutId: players[0].tryoutId,
      }).session(session);

      const allPaid = allRegistrations.every(
        (reg) => reg.paymentStatus === 'paid'
      );

      await Parent.findByIdAndUpdate(
        parent._id,
        {
          $set: {
            paymentComplete: allPaid,
            updatedAt: new Date(),
          },
        },
        { session }
      );

      // Send receipt email
      try {
        await sendEmail({
          to: email,
          subject: 'Your Tryout Payment Receipt',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
              <h2 style="color: #2c3e50;">Thank you for your tryout payment!</h2>
              <p style="font-size: 16px;">We've successfully processed your payment for <strong>${players.length}</strong> player(s).</p>
              <hr style="margin: 20px 0;" />
              <p><strong>Players:</strong></p>
              <ul>
                ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
              </ul>
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
          paymentStatus: p.paymentStatus,
          paymentComplete: p.paymentComplete,
          registrationComplete: p.registrationComplete,
          seasons: p.seasons.map((s) => ({
            season: s.season,
            year: s.year,
            tryoutId: s.tryoutId,
            paymentStatus: s.paymentStatus,
            paymentComplete: s.paymentComplete,
            paymentDate: s.paymentDate,
            registrationDate: s.registrationDate,
          })),
        })),
        status: 'processed',
        receiptUrl: paymentResult.receiptUrl,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Payment processing error:', {
        message: error.message,
        stack: error.stack,
        requestBody: {
          playerIds: players.map((p) => p.playerId),
          season: players[0]?.season,
          year: players[0]?.year,
          tryoutId: players[0]?.tryoutId,
          amount: amount / 100,
        },
        user: req.user,
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
