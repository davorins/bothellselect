const { Client, Environment } = require('square');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
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
    playerId,
    playerCount,
    cardDetails,
    locationId,
    buyerEmailAddress,
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
      locationId: locationId || process.env.SQUARE_LOCATION_ID,
      autocomplete: true,
      referenceId: `parent:${parentId}`,
      note: playerId
        ? `Payment for player ${playerId}`
        : playerCount
          ? `Payment for ${playerCount} player(s)`
          : 'Registration payment',
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
      playerId: playerId || null,
      parentId,
      paymentId: squarePayment.id,
      amount: amount / 100, // Store in dollars
      status: squarePayment.status.toLowerCase(),
      receiptUrl: squarePayment.receiptUrl,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand || 'UNKNOWN',
      cardExpMonth: cardDetails.exp_month || '00',
      cardExpYear: cardDetails.exp_year || '00',
      locationId: squarePayment.locationId,
      buyerEmail: buyerEmailAddress,
      playerCount: playerCount || null,
    });

    await paymentRecord.save({ session });

    // Update parent payment status
    await Parent.updateOne(
      { _id: parentId },
      { $set: { paymentComplete: true } },
      { session }
    );

    // Update player status if specified
    if (playerId) {
      await Player.updateMany(
        { parentId },
        { $set: { paymentComplete: true } },
        { session }
      );
    }

    // Send receipt email
    await sendEmail({
      to: buyerEmailAddress,
      subject: 'Payment Confirmation - Basketball Camp',
      html: `
        <h2>Payment Successful</h2>
        <p>Amount: $${(amount / 100).toFixed(2)}</p>
        ${playerCount ? `<p>Players: ${playerCount}</p>` : ''}
        ${playerId ? `<p>Player ID: ${playerId}</p>` : ''}
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
        playerUpdated: !!playerId,
        parentUpdated: true,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment processing failed:', error);
    throw new Error(`Payment failed: ${error.message}`);
  } finally {
    session.endSession();
  }
}

module.exports = {
  submitPayment,
  client,
};
