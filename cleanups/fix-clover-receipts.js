// fix-clover-receipts.js (in /cleanups folder)
const mongoose = require('mongoose');
// ✅ Point to parent directory's .env file
require('dotenv').config({ path: '../.env' });

// Adjust path to models (go up one level)
const Payment = require('../models/Payment');

async function fixCloverReceipts() {
  try {
    console.log('🔧 FIXING CLOVER PAYMENT RECEIPTS');
    console.log('===================================\n');

    console.log('Connecting to MongoDB...');
    await mongoose.connect(
      process.env.MONGODB_URI || 'mongodb://localhost:27017/bothell-select',
      {
        useNewUrlParser: true,
        useUnifiedTopology: true,
      },
    );

    console.log('✅ Connected to MongoDB');

    // Find all Clover payments without receipt URLs
    const payments = await Payment.find({
      paymentSystem: 'clover',
      $or: [
        { receiptUrl: { $exists: false } },
        { receiptUrl: null },
        { receiptUrl: '' },
      ],
    });

    console.log(
      `\n📊 Found ${payments.length} Clover payment(s) without receipt URLs`,
    );

    if (payments.length === 0) {
      console.log('✅ No payments need updating!');
      process.exit(0);
    }

    let updatedCount = 0;

    for (const payment of payments) {
      // ✅ Use CORRECT Clover receipt URL format with merchant ID
      // Format: https://www.clover.com/r/{merchantId}/{paymentId}
      const merchantId = payment.merchantId;
      const paymentId = payment.paymentId;

      // Skip if merchantId is missing
      if (!merchantId) {
        console.log(
          `\n⚠️ Skipping payment ${payment._id} - missing merchantId`,
        );
        console.log(`   Payment ID: ${paymentId}`);
        continue;
      }

      const receiptUrl = `https://www.clover.com/r/${merchantId}/${paymentId}`;

      console.log(`\n📝 Updating payment ${payment._id}:`);
      console.log(`   Merchant ID: ${merchantId}`);
      console.log(`   Payment ID: ${paymentId}`);
      console.log(`   New Receipt URL: ${receiptUrl}`);

      payment.receiptUrl = receiptUrl;
      await payment.save();

      updatedCount++;
      console.log(`   ✅ Updated successfully`);
    }

    console.log('\n===================================');
    console.log(`✅ Fix completed! Updated ${updatedCount} payment(s)`);
    console.log('===================================\n');

    // Verify the updates
    const verifyPayments = await Payment.find({
      paymentSystem: 'clover',
      receiptUrl: { $exists: true, $ne: null },
    });

    console.log(
      `🔍 Verification: ${verifyPayments.length} Clover payment(s) now have receipt URLs`,
    );

    if (verifyPayments.length > 0) {
      console.log('\n📋 Sample of updated receipts:');
      verifyPayments.slice(0, 3).forEach((payment, i) => {
        console.log(`   ${i + 1}. ${payment.receiptUrl}`);
      });
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Error fixing Clover receipts:', error);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

fixCloverReceipts();
