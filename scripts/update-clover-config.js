// scripts/update-clover-config.js
const mongoose = require('mongoose');
require('dotenv').config();

async function updateConfig() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB');

  // Make sure CLOVER_ECOMMERCE_PRIVATE_KEY is set in your .env file
  const privateKey = process.env.CLOVER_ECOMMERCE_PRIVATE_KEY;

  if (!privateKey) {
    console.error('❌ CLOVER_ECOMMERCE_PRIVATE_KEY not set in .env file');
    process.exit(1);
  }

  const result = await mongoose.connection
    .collection('paymentconfigurations')
    .updateOne(
      { paymentSystem: 'clover' },
      {
        $set: {
          paymentSystem: 'clover',
          isActive: true,
          isDefault: true,
          'cloverConfig.accessToken': privateKey, // Your sk_... private key
          'cloverConfig.merchantId': 'R7TMPF78A7AB1', // ← CORRECTED Merchant ID
          'cloverConfig.environment': 'production',
          'cloverConfig.apiBaseUrl': 'https://api.clover.com/v3',
          'cloverConfig.refreshToken': '', // Clear OAuth token
          'cloverConfig.tokenExpiresAt': null, // No expiration for Ecommerce keys
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );

  console.log('✅ Clover config updated:', result);
  console.log('   Merchant ID set to: R7TMPF78A7AB1');
  console.log(
    '   Using Private Key starting with:',
    privateKey.substring(0, 10) + '...',
  );
  process.exit(0);
}

updateConfig();
