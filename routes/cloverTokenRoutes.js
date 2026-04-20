const express = require('express');
const router = express.Router();
const PaymentConfiguration = require('../models/PaymentConfiguration');
const axios = require('axios');

router.post('/create-token', async (req, res) => {
  try {
    const { cardNumber, cardExpiry, cardCvv, cardPostal } = req.body;

    // Get active Clover config
    const config = await PaymentConfiguration.findOne({
      isActive: true,
      paymentSystem: 'clover',
    }).select('+cloverConfig.accessToken');

    if (!config?.cloverConfig?.accessToken) {
      return res.status(400).json({ error: 'Clover not configured' });
    }

    const { accessToken, merchantId, environment } = config.cloverConfig;
    const baseUrl =
      environment === 'production'
        ? 'https://token.clover.com'
        : 'https://token-sandbox.dev.clover.com';

    const [expMonth, expYear] = cardExpiry.split('/');

    const pakmsKey = 'ac9732ecee370a3c9aead677f4c26db5';

    const response = await axios.post(
      `${baseUrl}/v1/tokens`,
      {
        card: {
          number: cardNumber,
          exp_month: expMonth,
          exp_year: `20${expYear}`,
          cvv: cardCvv,
          last4: cardNumber.slice(-4),
        },
      },
      {
        headers: {
          apikey: pakmsKey,
          'Content-Type': 'application/json',
        },
      },
    );

    res.json({ token: response.data.id });
  } catch (err) {
    console.error(
      'Clover tokenization error:',
      err.response?.data || err.message,
    );
    res.status(400).json({
      error: err.response?.data?.message || 'Failed to create payment token',
    });
  }
});

module.exports = router;
