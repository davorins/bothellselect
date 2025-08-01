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

async function submitPayment(
  sourceId,
  amount,
  {
    parentId,
    playerIds = [], // Default to empty array
    season, // Added season
    year, // Added year
    tryoutId, // Added tryoutId
    cardDetails,
    buyerEmailAddress,
    description = 'Form submission payment',
  }
) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate minimum requirements
    if (!sourceId) throw new Error('Source ID is required');
    if (!amount || isNaN(amount)) throw new Error('Valid amount is required');
    if (!parentId) throw new Error('Parent ID is required');
    if (!buyerEmailAddress) throw new Error('Email is required for receipt');
    if (!cardDetails?.last_4) throw new Error('Card details incomplete');
    if (!Array.isArray(playerIds))
      throw new Error('Player IDs must be an array');
    if (!process.env.SQUARE_LOCATION_ID)
      throw new Error('Square location ID not configured');

    // Validate player IDs if provided
    if (playerIds.length > 0) {
      const validPlayers = await Player.countDocuments({
        _id: { $in: playerIds },
        parentId,
      }).session(session);

      if (validPlayers !== playerIds.length) {
        throw new Error(
          'One or more players not found or do not belong to parent'
        );
      }
    }

    // Create or find Square customer
    const { result: customerResult } = await customersApi.createCustomer({
      emailAddress: buyerEmailAddress,
      idempotencyKey: randomUUID(),
    });
    const customerId = customerResult.customer?.id;
    if (!customerId) throw new Error('Failed to create customer record');

    // Create payment request
    const paymentRequest = {
      idempotencyKey: randomUUID(),
      sourceId,
      amountMoney: {
        amount: amount,
        currency: 'USD',
      },
      customerId,
      locationId: process.env.SQUARE_LOCATION_ID, // Always use from env
      autocomplete: true,
      referenceId: `parent:${parentId}`,
      note:
        playerIds.length > 0
          ? `Payment for ${playerIds.length} player(s)`
          : description,
      buyerEmailAddress,
    };

    // Process payment with Square
    const { result } = await paymentsApi.createPayment(paymentRequest);
    const squarePayment = result.payment;

    if (!squarePayment || squarePayment.status !== 'COMPLETED') {
      throw new Error(`Payment failed with status: ${squarePayment?.status}`);
    }

    // Store payment details
    const paymentRecord = new Payment({
      playerIds,
      parentId,
      paymentId: squarePayment.id,
      amount: amount / 100,
      status: squarePayment.status.toLowerCase(),
      receiptUrl: squarePayment.receiptUrl,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand || 'UNKNOWN',
      cardExpMonth: cardDetails.exp_month || '00',
      cardExpYear: cardDetails.exp_year || '00',
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmail: buyerEmailAddress,
      players: playerIds.map((id) => ({
        playerId: id,
        season,
        year,
        tryoutId,
      })),
    });

    await paymentRecord.save({ session });

    // Update parent payment status
    await Parent.updateOne(
      { _id: parentId },
      {
        $set: {
          paymentComplete: true,
          lastPaymentDate: new Date(),
        },
        $push: { payments: paymentRecord._id },
      },
      { session }
    );

    // Update players if specified
    if (playerIds.length > 0) {
      await Promise.all([
        // Update player documents
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
    }

    // Send receipt email
    await sendEmail({
      to: buyerEmailAddress,
      subject: 'Payment Confirmation - Basketball Camp',
      html: `
        <h2>Payment Successful</h2>
        <p>Amount: $${(amount / 100).toFixed(2)}</p>
        ${playerIds.length > 0 ? `<p>Players: ${playerIds.length}</p>` : ''}
        <p>Payment ID: ${squarePayment.id}</p>
        <p>Date: ${new Date().toLocaleDateString()}</p>
        <p><a href="${squarePayment.receiptUrl}">View Receipt</a></p>
      `,
    });

    await session.commitTransaction();

    return {
      success: true,
      payment: {
        id: paymentRecord._id,
        squareId: squarePayment.id,
        amount: amount / 100,
        status: squarePayment.status,
        receiptUrl: squarePayment.receiptUrl,
        playersUpdated: playerIds.length,
        parentUpdated: true,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment processing failed:', {
      error: error.message,
      stack: error.stack,
      parentId,
      playerIds,
    });
    throw error; // Re-throw the original error to preserve stack trace
  } finally {
    session.endSession();
  }
}

module.exports = {
  submitPayment,
  client,
};
