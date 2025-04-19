const { Client, Environment } = require('square');
const { randomUUID } = require('crypto');
const Payment = require('../models/Payment');
require('dotenv').config();

// Initialize Square Client
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production,
});

const paymentsApi = client.paymentsApi;

async function submitPayment(
  sourceId,
  amount,
  { parentId, playerId, cardDetails, locationId }
) {
  try {
    // Validate minimum requirements
    if (!sourceId) throw new Error('Source ID is required');
    if (!amount || isNaN(amount)) throw new Error('Valid amount is required');
    if (!parentId) throw new Error('Parent ID is required');

    // Convert amount to cents if needed
    const amountInCents = amount < 100 ? amount * 100 : amount;

    // Create payment request
    const paymentRequest = {
      idempotencyKey: randomUUID(),
      sourceId,
      amountMoney: {
        amount: amountInCents,
        currency: 'USD',
      },
      locationId: locationId || process.env.SQUARE_LOCATION_ID,
      autocomplete: true,
      referenceId: `parent:${parentId}`,
      note: playerId
        ? `Payment for player ${playerId}`
        : 'Registration payment',
    };

    // Process payment with Square
    const { result } = await paymentsApi.createPayment(paymentRequest);

    if (!result.payment || result.payment.status !== 'COMPLETED') {
      throw new Error('Payment not completed successfully');
    }

    // Store payment details
    const paymentRecord = {
      playerId: playerId || null,
      parentId,
      paymentId: result.payment.id,
      amount: amountInCents,
      status: result.payment.status.toLowerCase(),
      receiptUrl: result.payment.receiptUrl,
      cardLastFour: cardDetails?.last_4 || '****',
      cardBrand: cardDetails?.card_brand || 'UNKNOWN',
      cardExpMonth: cardDetails?.exp_month || '00',
      cardExpYear: cardDetails?.exp_year || '00',
      locationId: result.payment.locationId,
    };

    const payment = new Payment(paymentRecord);
    await payment.save();

    return {
      success: true,
      payment: {
        id: payment._id,
        squareId: result.payment.id,
        amount: amountInCents,
        status: result.payment.status,
      },
    };
  } catch (error) {
    console.error('Payment processing failed:', error);
    throw error;
  }
}

module.exports = { submitPayment };
