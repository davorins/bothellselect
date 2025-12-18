// services/form-payments.js
const { Client, Environment } = require('square');
const crypto = require('crypto');
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

async function processFormPayment(paymentToken, amount, currency, metadata) {
  try {
    const { result } = await client.paymentsApi.createPayment({
      sourceId: paymentToken,
      idempotencyKey: crypto.randomUUID(),
      amountMoney: {
        amount: amount, // Amount in cents
        currency: currency,
      },
      locationId: process.env.SQUARE_LOCATION_ID,
      note: `Form: ${metadata.formTitle || metadata.formId} - ${metadata.fieldLabel || 'Payment'}`,
      buyerEmailAddress: metadata.buyerEmail,
      metadata: {
        formId: metadata.formId,
        submissionId: metadata.submissionId,
        fieldId: metadata.fieldId,
        selectedPackage: metadata.selectedPackage,
        quantity: metadata.quantity,
        type: 'form_payment',
        processedAt: new Date().toISOString(),
      },
    });

    return {
      success: true,
      payment: result.payment,
    };
  } catch (error) {
    console.error('Square Payment Error:', error);

    // Handle specific Square errors
    if (error.errors && error.errors.length > 0) {
      const squareError = error.errors[0];
      throw new Error(
        `Payment failed: ${squareError.detail || squareError.code}`
      );
    }

    throw new Error(`Payment failed: ${error.message}`);
  }
}

module.exports = { processFormPayment };
