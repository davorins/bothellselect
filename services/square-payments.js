const { Client, Environment } = require('square');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Registration = require('../models/Registration');
require('dotenv').config();
const { sendEmail } = require('../utils/email');

// Initialize Square Client
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

const { paymentsApi, customersApi } = client;

/**
 * Processes a payment and updates all related records in MongoDB
 * @param {string} sourceId - Square payment source token
 * @param {number} amount - Amount in cents (e.g., $10.00 = 1000)
 * @param {Object} params - Payment parameters
 * @param {string} params.parentId - Parent ID making the payment
 * @param {string[]} params.playerIds - Array of player IDs
 * @param {string} params.season - Season identifier
 * @param {number} params.year - Year
 * @param {string} params.tryoutId - Tryout ID
 * @param {Object} params.cardDetails - Card details
 * @param {string} params.cardDetails.last_4 - Last 4 digits
 * @param {string} params.cardDetails.card_brand - Card brand
 * @param {string} params.cardDetails.exp_month - Expiration month
 * @param {string} params.cardDetails.exp_year - Expiration year
 * @param {string} params.buyerEmailAddress - Email for receipt
 * @returns {Promise<Object>} Payment result
 */
async function processTryoutPayment(
  sourceId,
  amount,
  {
    parentId,
    playerIds,
    season,
    year,
    tryoutId,
    cardDetails,
    buyerEmailAddress,
  }
) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate input
    if (!sourceId) throw new Error('Payment source token is required');
    if (!amount || isNaN(amount)) throw new Error('Valid amount is required');
    if (!parentId) throw new Error('Parent ID is required');
    if (!playerIds || !Array.isArray(playerIds) || playerIds.length === 0) {
      throw new Error('At least one player ID is required');
    }
    if (!season || !year || !tryoutId) {
      throw new Error('Season, year, and tryout ID are required');
    }

    // Verify all players belong to this parent
    const players = await Player.find({ _id: { $in: playerIds } }).session(
      session
    );
    if (players.length !== playerIds.length) {
      throw new Error('One or more players not found');
    }
    if (players.some((p) => p.parentId.toString() !== parentId)) {
      throw new Error('One or more players belong to a different parent');
    }

    // Create Square customer
    const { result: customerResult } = await customersApi.createCustomer({
      emailAddress: buyerEmailAddress,
      idempotencyKey: randomUUID(),
    });
    const customerId = customerResult.customer?.id;
    if (!customerId) throw new Error('Failed to create customer record');

    // Create Square payment
    const paymentRequest = {
      idempotencyKey: randomUUID(),
      sourceId,
      amountMoney: {
        amount: amount,
        currency: 'USD',
      },
      customerId,
      locationId: process.env.SQUARE_LOCATION_ID,
      autocomplete: true,
      referenceId: `parent:${parentId}`,
      note: `Tryout payment for ${playerIds.length} player(s)`,
      buyerEmailAddress,
    };

    const { result } = await paymentsApi.createPayment(paymentRequest);
    const squarePayment = result.payment;

    if (!squarePayment || squarePayment.status !== 'COMPLETED') {
      throw new Error(`Payment failed with status: ${squarePayment?.status}`);
    }

    // Create payment record
    const paymentRecord = new Payment({
      parentId,
      playerIds,
      paymentId: squarePayment.id,
      amount: amount / 100,
      status: squarePayment.status.toLowerCase(),
      receiptUrl: squarePayment.receiptUrl,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand || 'UNKNOWN',
      cardExpMonth: cardDetails.exp_month || '00',
      cardExpYear: cardDetails.exp_year || '00',
      locationId: squarePayment.locationId,
      buyerEmail: buyerEmailAddress,
      players: playerIds.map((id) => ({
        playerId: id,
        season,
        year,
        tryoutId,
      })),
    });

    await paymentRecord.save({ session });

    // Update all related records in parallel
    await Promise.all([
      // Update parent
      Parent.updateOne(
        { _id: parentId },
        {
          $set: {
            paymentComplete: true,
            lastPaymentDate: new Date(),
          },
          $push: {
            payments: paymentRecord._id,
          },
        },
        { session }
      ),

      // Update players
      Player.updateMany(
        { _id: { $in: playerIds } },
        {
          $set: {
            paymentComplete: true,
            paymentStatus: 'paid',
          },
          $push: {
            seasons: {
              season,
              year,
              tryoutId,
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
          player: { $in: playerIds },
          season,
          year,
          tryoutId,
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
    ]);

    // Send confirmation email
    await sendEmail({
      to: buyerEmailAddress,
      subject: `Payment Confirmation - ${season} ${year} Tryouts`,
      html: `
        <h2>Payment Successful</h2>
        <p>Amount: $${(amount / 100).toFixed(2)}</p>
        <p>Players: ${playerIds.length}</p>
        <p>Season: ${season} ${year}</p>
        <p>Payment ID: ${squarePayment.id}</p>
        <p>Date: ${new Date().toLocaleDateString()}</p>
        <p><a href="${squarePayment.receiptUrl}">View Receipt</a></p>
      `,
    });

    await session.commitTransaction();
    console.log('Transaction successfully committed');

    return {
      success: true,
      paymentId: paymentRecord._id,
      squarePaymentId: squarePayment.id,
      amount: amount / 100,
      playersUpdated: playerIds.length,
      receiptUrl: squarePayment.receiptUrl,
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment transaction failed:', {
      error: error.message,
      stack: error.stack,
      parentId,
      playerIds,
    });
    throw error;
  } finally {
    session.endSession();
  }
}

module.exports = {
  processTryoutPayment,
  client,
};
