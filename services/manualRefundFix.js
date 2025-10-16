// services/manualRefundFix.js
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI);

async function manualRefundFix() {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const paymentId = '7Lpb9EG7emFzfIMHNYyl96J36KJZY';

    console.log('🔧 Manual refund fix for payment:', paymentId);

    const payment = await Payment.findOne({ paymentId }).session(session);

    if (!payment) {
      console.log('❌ Payment not found');
      return;
    }

    console.log('✅ Found payment:');
    console.log('   Amount: $', payment.amount);
    console.log('   Current refunds:', payment.refunds?.length || 0);

    // Add the $1050 refund manually
    payment.refundedAmount = 1050;
    payment.refundStatus = 'full';

    if (!payment.refunds) {
      payment.refunds = [];
    }

    payment.refunds.push({
      refundId: 'manual_fix_1',
      squareRefundId: 'manual_j7LJPwl79zRa5u28Ei7gFTJFQjMZY',
      amount: 1050,
      reason: 'Refund processed in Square Dashboard',
      status: 'completed',
      processedAt: new Date('2025-10-13T16:33:00Z'), // Use the date from your receipt
      notes: 'Manually added - refund was $1050 processed on Oct 13, 2025',
      source: 'square_dashboard',
    });

    await payment.save({ session });
    await session.commitTransaction();

    console.log('✅ MANUAL FIX COMPLETE!');
    console.log('💰 Refund added: $1050');
    console.log('📊 Refund status: full');
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Error:', error);
  } finally {
    session.endSession();
  }
}

manualRefundFix().then(() => {
  mongoose.connection.close();
  console.log('Database connection closed');
});
