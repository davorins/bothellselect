// scripts/update-clover-config.js
const mongoose = require('mongoose');
require('dotenv').config();

async function updateConfig() {
  await mongoose.connect(process.env.MONGODB_URI);

  await mongoose.connection.collection('paymentconfigurations').updateOne(
    { paymentSystem: 'clover' },
    {
      $set: {
        paymentSystem: 'clover',
        isActive: true,
        isDefault: true,
        'cloverConfig.accessToken': process.env.CLOVER_ECOMMERCE_PRIVATE_KEY,
        'cloverConfig.merchantId': 'JZXAD8PSMX671',
        'cloverConfig.environment': 'production',
        'cloverConfig.apiBaseUrl': 'https://api.clover.com/v3',
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  );

  console.log('✅ Clover config updated');
  process.exit(0);
}

updateConfig();
