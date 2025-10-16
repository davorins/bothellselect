// services/verifyRefund.js
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI);

async function verifyRefund() {
  try {
    const paymentId = '7Lpb9EG7emFzfIMHNYyl96J36KJZY';

    console.log('🔍 Verifying refund for payment:', paymentId);

    const payment = await Payment.findOne({ paymentId });

    if (!payment) {
      console.log('❌ Payment not found');
      return;
    }

    console.log('✅ Payment found:');
    console.log('   Amount: $', payment.amount);
    console.log('   Refunded Amount: $', payment.refundedAmount || 0);
    console.log('   Refund Status:', payment.refundStatus);
    console.log('   Number of Refunds:', payment.refunds?.length || 0);

    if (payment.refunds && payment.refunds.length > 0) {
      console.log('\n📋 Refund Details:');
      payment.refunds.forEach((refund, index) => {
        console.log(`   Refund ${index + 1}:`);
        console.log(`     - Amount: $${refund.amount}`);
        console.log(`     - Status: ${refund.status}`);
        console.log(`     - Reason: ${refund.reason}`);
        console.log(`     - Processed: ${refund.processedAt}`);
        console.log(`     - Source: ${refund.source}`);
      });
    } else {
      console.log('❌ No refunds found - manual fix may be needed');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

verifyRefund().then(() => {
  mongoose.connection.close();
  console.log('Verification complete');
});
