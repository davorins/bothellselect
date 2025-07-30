const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const { Client, Environment } = require('square');
const crypto = require('crypto');
const { sendEmail } = require('../utils/email');
const authenticate = require('../middleware/authenticate');
const Player = require('../models/Player');
const Payment = require('../models/Payment');
const Parent = require('../models/Parent');

const square = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

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
      packageType,
      season,
      year,
    } = req.body;

    // Validate input
    if (
      !sourceId ||
      !amount ||
      !parentId ||
      !playerIds ||
      !Array.isArray(playerIds) ||
      playerIds.length === 0
    ) {
      throw new Error(
        'Missing required fields: sourceId, amount, parentId, or playerIds'
      );
    }
    if (playerCount !== playerIds.length) {
      throw new Error('Player count does not match the number of player IDs');
    }
    if (!locationId || !buyerEmailAddress) {
      throw new Error('Missing locationId or buyerEmailAddress');
    }

    // Verify parent and players
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) throw new Error('Parent not found');
    const players = await Player.find({
      _id: { $in: playerIds },
      parentId,
    }).session(session);
    if (players.length !== playerIds.length) {
      throw new Error(
        'One or more player IDs are invalid or not associated with the parent'
      );
    }

    // Create Square payment
    const paymentRequest = {
      sourceId,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: crypto.randomBytes(32).toString('hex'),
      locationId,
      customerId: (
        await square.customersApi.createCustomer({
          emailAddress: buyerEmailAddress,
        })
      ).result.customer?.id,
      referenceId: `parent:${parentId}`,
      note: `Payment for ${playerCount} player(s) for ${season} ${year}`,
    };

    const paymentResponse =
      await square.paymentsApi.createPayment(paymentRequest);
    if (paymentResponse.result.payment?.status !== 'COMPLETED') {
      throw new Error(
        `Payment failed with status: ${paymentResponse.result.payment?.status}`
      );
    }

    // Create payment record
    const payment = new Payment({
      parentId,
      playerIds,
      paymentId: paymentResponse.result.payment.id,
      locationId,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand,
      amount: amount / 100,
      currency: 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResponse.result.payment?.receiptUrl,
    });
    await payment.save({ session });

    // Update players' seasons
    for (const playerId of playerIds) {
      const player = await Player.findOne(
        { _id: playerId, 'seasons.season': season, 'seasons.year': year },
        null,
        { session }
      );
      if (player) {
        await Player.updateOne(
          { _id: playerId, 'seasons.season': season, 'seasons.year': year },
          {
            $set: {
              'seasons.$.paymentComplete': true,
              'seasons.$.paymentStatus': 'paid',
              'seasons.$.paymentId': paymentResponse.result.payment.id,
              'seasons.$.amountPaid': amount / playerCount / 100,
              'seasons.$.cardLast4': cardDetails.last_4,
              'seasons.$.cardBrand': cardDetails.card_brand,
              'seasons.$.packageType': packageType,
            },
          },
          { session }
        );
      } else {
        await Player.updateOne(
          { _id: playerId },
          {
            $push: {
              seasons: {
                season,
                year,
                paymentComplete: true,
                paymentStatus: 'paid',
                paymentId: paymentResponse.result.payment.id,
                amountPaid: amount / playerCount / 100,
                cardLast4: cardDetails.last_4,
                cardBrand: cardDetails.card_brand,
                packageType,
                registrationDate: new Date(),
              },
            },
          },
          { session }
        );
      }
    }

    // Send confirmation email
    const playerNames = players.map((p) => p.fullName).join(', ');
    await sendEmail({
      to: buyerEmailAddress,
      subject: `Payment Confirmation for ${season} ${year}`,
      html: `
        <h2>Payment Confirmation</h2>
        <p>Thank you for your payment for ${playerNames}.</p>
        <p><strong>Season:</strong> ${season} ${year}</p>
        <p><strong>Package:</strong> ${packageType === '1' ? '3 Times/Week' : '4 Times/Week'}</p>
        <p><strong>Amount:</strong> $${(amount / 100).toFixed(2)}</p>
        <p><strong>Card:</strong> ${cardDetails.card_brand} ending in ${cardDetails.last_4}</p>
        <p><strong>Receipt:</strong> <a href="${paymentResponse.result.payment?.receiptUrl}">View Receipt</a></p>
      `,
    });

    await session.commitTransaction();
    res.json({
      success: true,
      paymentId: payment._id,
      playerIds,
      receiptUrl: paymentResponse.result.payment?.receiptUrl,
    });
  } catch (error) {
    await session.abortTransaction();
    res.status(400).json({ success: false, error: error.message });
  } finally {
    session.endSession();
  }
});

module.exports = router;
