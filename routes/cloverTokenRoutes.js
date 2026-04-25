const express = require('express');
const router = express.Router();
const axios = require('axios');

router.post('/create-token', async (req, res) => {
  try {
    const { cardNumber, cardExpiry, cardCvv, cardPostal } = req.body;

    const ecommercePublicKey = process.env.CLOVER_ECOMMERCE_PUBLIC_KEY;

    if (!ecommercePublicKey) {
      console.error('❌ CLOVER_ECOMMERCE_PUBLIC_KEY not set');
      return res.status(500).json({ error: 'Payment configuration error' });
    }

    const [expMonth, expYear] = cardExpiry.split('/');

    const response = await axios.post(
      'https://token.clover.com/v1/tokens',
      {
        card: {
          number: cardNumber.replace(/\s/g, ''),
          exp_month: parseInt(expMonth),
          exp_year: parseInt(`20${expYear}`),
          cvv: cardCvv,
          ...(cardPostal && { postal_code: cardPostal }),
        },
      },
      {
        headers: {
          apikey: ecommercePublicKey,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );

    console.log('✅ Clover token created:', response.data.id);
    res.json({ token: response.data.id });
  } catch (error) {
    console.error('❌ Clover error:', error.response?.data || error.message);
    res.status(400).json({ error: 'Failed to create payment token' });
  }
});

module.exports = router;
