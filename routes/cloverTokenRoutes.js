const express = require('express');
const router = express.Router();
const axios = require('axios');
const { authenticate } = require('../utils/auth');

router.post('/create-token', authenticate, async (req, res) => {
  try {
    const { cardNumber, cardExpiry, cardCvv, cardPostal } = req.body;

    // Use the Ecommerce Public Key from environment variables
    const ecommercePublicKey = process.env.CLOVER_ECOMMERCE_PUBLIC_KEY;

    if (!ecommercePublicKey) {
      console.error('❌ CLOVER_ECOMMERCE_PUBLIC_KEY not set in environment');
      return res.status(500).json({
        error:
          'Payment system configuration error. Please contact administrator.',
      });
    }

    // Parse expiry date (MM/YY format)
    const [expMonth, expYear] = cardExpiry.split('/');

    // Use Production tokenization URL
    const tokenizationUrl = 'https://token.clover.com/v1/tokens';

    console.log('🔄 Creating Clover payment token...');

    const response = await axios.post(
      tokenizationUrl,
      {
        card: {
          number: cardNumber.replace(/\s/g, ''), // Remove spaces
          exp_month: parseInt(expMonth),
          exp_year: parseInt(`20${expYear}`),
          cvv: cardCvv,
          ...(cardPostal && { postal_code: cardPostal }),
        },
      },
      {
        headers: {
          apikey: ecommercePublicKey, // Use Public Key as apikey
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      },
    );

    console.log('✅ Clover token created successfully:', response.data.id);

    // Return the token ID to the frontend
    res.json({
      token: response.data.id,
      cardType: response.data.card_type || 'unknown',
    });
  } catch (error) {
    console.error('❌ Clover tokenization error:', {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    // Provide user-friendly error messages
    let errorMessage = 'Failed to create payment token';
    if (error.response?.status === 401) {
      errorMessage =
        'Clover API authentication failed. Please check your Ecommerce Public Key.';
    } else if (error.response?.status === 400) {
      errorMessage =
        error.response.data?.message ||
        'Invalid card information. Please check your card details.';
    } else if (error.code === 'ECONNABORTED') {
      errorMessage = 'Request timed out. Please try again.';
    }

    res.status(error.response?.status || 400).json({
      error: errorMessage,
    });
  }
});

module.exports = router;
