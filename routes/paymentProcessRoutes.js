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
      console.error('Validation errors:', errors.array());
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

      console.log('Payment request:', { userId: req.user.id, players, amount });

      // Verify parent exists
      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        throw new Error('Parent not found');
      }

      // Verify players
      const playerIds = players
        .map((p) => p.playerId)
        .filter((id) => id && mongoose.Types.ObjectId.isValid(id));
      let playerRecords = [];
      if (playerIds.length > 0) {
        playerRecords = await Player.find({
          _id: { $in: playerIds },
          parentId: parent._id,
        }).session(session);
        if (playerIds.length > 0 && playerRecords.length === 0) {
          throw new Error('No players found for provided IDs');
        }
      }

      // Handle players without IDs
      const playersWithoutId = players.filter((p) => !p.playerId);
      for (const player of playersWithoutId) {
        let playerRecord = await Player.findOne({
          parentId: parent._id,
          'seasons.season': player.season,
          'seasons.year': player.year,
          'seasons.tryoutId': player.tryoutId || null,
        }).session(session);

        if (!playerRecord) {
          // Create a new player if none exists (fallback)
          playerRecord = new Player({
            parentId: parent._id,
            fullName: player.fullName || 'Unknown Player', // Adjust based on schema
            season: player.season,
            registrationYear: player.year,
            seasons: [
              {
                season: player.season,
                year: player.year,
                tryoutId: player.tryoutId || null,
                registrationDate: new Date(),
              },
            ],
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          await playerRecord.save({ session });
          console.log(
            `Created new player for ${player.season}, ${player.year}:`,
            playerRecord._id
          );
        }
        player.playerId = playerRecord._id.toString();
        playerRecords.push(playerRecord);
      }

      if (playerRecords.length === 0) {
        throw new Error('No valid players found for payment');
      }

      // Create or retrieve Square customer
      let customerId = parent.squareCustomerId;
      if (!customerId) {
        const { result: customerResult } =
          await client.customersApi.createCustomer({
            emailAddress: email,
            givenName: parent.fullName
              ? parent.fullName.split(' ')[0]
              : 'Unknown',
            familyName: parent.fullName
              ? parent.fullName.split(' ').slice(1).join(' ')
              : 'Parent',
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
        note: `Tryout payment for ${playerRecords.length} player(s)`,
        buyerEmailAddress: email,
      };

      console.log('Square payment request:', paymentRequest);

      const paymentResponse =
        await client.paymentsApi.createPayment(paymentRequest);
      const paymentResult = paymentResponse.result.payment;

      if (paymentResult.status !== 'COMPLETED') {
        throw new Error(`Payment failed with status: ${paymentResult.status}`);
      }

      // Create Payment record
      const payment = new Payment({
        parentId: parent._id,
        playerCount: playerRecords.length,
        playerIds: playerRecords.map((p) => p._id),
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

      // Update Player and Registration records
      const updatePromises = playerRecords.map(async (player) => {
        const seasonData = {
          season: players[0].season,
          year: players[0].year,
          tryoutId: players[0].tryoutId || null,
        };

        // Check if season exists in player's seasons array
        const seasonExists = player.seasons?.some(
          (s) =>
            s.season === seasonData.season &&
            s.year === seasonData.year &&
            s.tryoutId === seasonData.tryoutId
        );

        // Update or create season
        if (!seasonExists) {
          await Player.findByIdAndUpdate(
            player._id,
            {
              $push: {
                seasons: {
                  ...seasonData,
                  registrationDate: new Date(),
                  registrationComplete: true,
                  paymentStatus: 'paid',
                  paymentComplete: true,
                  paymentId: paymentResult.id,
                  amountPaid: amount / 100 / playerRecords.length,
                  cardLast4: cardDetails.last_4,
                  cardBrand: cardDetails.card_brand,
                  paymentDate: new Date(),
                },
              },
              $set: {
                paymentComplete: true,
                paymentStatus: 'paid',
                registrationComplete: true,
                updatedAt: new Date(),
              },
            },
            { session }
          );
          console.log(
            `Created new season for player ${player._id}:`,
            seasonData
          );
        } else {
          const playerUpdate = await Player.findByIdAndUpdate(
            player._id,
            {
              $set: {
                'seasons.$[season].registrationComplete': true,
                'seasons.$[season].paymentStatus': 'paid',
                'seasons.$[season].paymentComplete': true,
                'seasons.$[season].paymentId': paymentResult.id,
                'seasons.$[season].amountPaid':
                  amount / 100 / playerRecords.length,
                'seasons.$[season].cardLast4': cardDetails.last_4,
                'seasons.$[season].cardBrand': cardDetails.card_brand,
                'seasons.$[season].paymentDate': new Date(),
                paymentComplete: true,
                paymentStatus: 'paid',
                registrationComplete: true,
                updatedAt: new Date(),
              },
            },
            {
              arrayFilters: [
                {
                  'season.season': seasonData.season,
                  'season.year': seasonData.year,
                  'season.tryoutId': seasonData.tryoutId || null,
                },
              ],
              session,
            }
          );
          console.log(`Player update for ${player._id}:`, {
            modified: !!playerUpdate,
            seasonData,
          });
        }

        // Update or create Registration record
        const registration = await Registration.findOne({
          player: player._id,
          season: seasonData.season,
          year: seasonData.year,
          tryoutId: seasonData.tryoutId || null,
        }).session(session);

        if (!registration) {
          const newRegistration = new Registration({
            player: player._id,
            season: seasonData.season,
            year: seasonData.year,
            tryoutId: seasonData.tryoutId || null,
            registrationComplete: true,
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentDate: new Date(),
            paymentId: paymentResult.id,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
          await newRegistration.save({ session });
          console.log(`Created new Registration for player ${player._id}:`, {
            season: seasonData.season,
            year: seasonData.year,
          });
        } else {
          const registrationUpdate = await Registration.updateOne(
            {
              player: player._id,
              season: seasonData.season,
              year: seasonData.year,
              tryoutId: seasonData.tryoutId || null,
            },
            {
              $set: {
                registrationComplete: true,
                paymentStatus: 'paid',
                paymentComplete: true,
                paymentDate: new Date(),
                paymentId: paymentResult.id,
                updatedAt: new Date(),
              },
            },
            { session }
          );
          console.log(`Registration update for player ${player._id}:`, {
            modifiedCount: registrationUpdate.modifiedCount,
            seasonData,
          });
        }
      });

      await Promise.all(updatePromises);

      // Update Parent
      const parentUpdate = await Parent.findByIdAndUpdate(
        parent._id,
        {
          $set: {
            paymentComplete: true,
            updatedAt: new Date(),
          },
        },
        { session }
      );
      console.log(`Parent update for ${parent._id}:`, {
        modified: !!parentUpdate,
      });

      // Fetch updated player records
      const updatedPlayers = await Player.find({
        _id: { $in: playerRecords.map((p) => p._id) },
      })
        .lean()
        .session(session);

      console.log('Updated players:', JSON.stringify(updatedPlayers, null, 2));

      // Send email receipt
      try {
        await sendEmail({
          to: email,
          subject: 'Your Tryout Payment Receipt',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto;">
              <h2 style="color: #2c3e50;">Thank you for your tryout payment!</h2>
              <p style="font-size: 16px;">We've successfully processed your payment for <strong>${playerRecords.length}</strong> player(s).</p>
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
        playersUpdated: playerRecords.length,
        playerIds: playerRecords.map((p) => p._id.toString()),
        players: updatedPlayers,
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
        details: error.message, // Always return details for debugging
      });
    } finally {
      session.endSession();
    }
  }
);

module.exports = router;
