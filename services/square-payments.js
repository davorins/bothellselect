const { Client, Environment } = require('square');
const { randomUUID } = require('crypto');
const Payment = require('../models/Payment');
require('dotenv').config();
const { sendEmail } = require('../utils/email');

// Initialize Square Client
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment: Environment.Production,
});

const paymentsApi = client.paymentsApi;

async function submitPayment(
  sourceId,
  amount,
  {
    parentId,
    playerId,
    cardDetails,
    locationId,
    buyerEmailAddress,
    squarePayment,
  }
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
      buyerEmailAddress,
    };

    // Process payment with Square
    const { result } = await paymentsApi.createPayment(paymentRequest);

    if (!result.payment || result.payment.status !== 'COMPLETED') {
      throw new Error('Payment not completed successfully');
    }

    const squarePayment = result.payment;

    await sendEmail({
      to: buyerEmailAddress,
      subject: 'Your Basketball Camp Payment Receipt',
      html: `
        <h2>Thank you for your payment!</h2>
        <p>Payment ID: ${result.payment.id}</p>
        <p>Amount: $${(amountInCents / 100).toFixed(2)}</p>
        <p>Status: ${result.payment.status}</p>
        <p><a href="${result.payment.receiptUrl}">View your receipt</a></p>
      `,
    });

    // Store payment details
    const paymentRecord = {
      playerId: playerId || null,
      parentId,
      paymentId: result.payment.id,
      amount: amountInCents,
      status: result.payment.status.toLowerCase(),
      receiptUrl: result.payment.receiptUrl,
      cardLastFour: squarePayment.cardDetails?.last_4 || '****',
      cardBrand: squarePayment.cardDetails?.card_brand || 'UNKNOWN',
      cardExpMonth: cardDetails?.exp_month || '00',
      cardExpYear: cardDetails?.exp_year || '00',
      locationId: result.payment.locationId,
      buyerEmail: buyerEmailAddress,
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
        receiptUrl: result.payment.receiptUrl,
      },
    };
  } catch (error) {
    console.error('Payment processing failed:', error);
    throw error;
  }
}

module.exports = { submitPayment };
