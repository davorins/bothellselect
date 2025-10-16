// services/manualRefundFix.js
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI);

async function manualRefundFix() {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const paymentId = '7L1VxFA3UK0RqZZEYYMbWun61rGZY';

    console.log('🔧 Manual refund fix for payment:', paymentId);

    const payment = await Payment.findOne({ paymentId }).session(session);

    if (!payment) {
      console.log('❌ Payment not found');
      return;
    }

    console.log('✅ Found payment:');
    console.log('   Amount: $', payment.amount);
    console.log('   Current refunds:', payment.refunds?.length || 0);

    // Add the $100 refund manually
    payment.refundedAmount = 100;
    payment.refundStatus = 'partial';

    if (!payment.refunds) {
      payment.refunds = [];
    }

    payment.refunds.push({
      refundId: 'manual_fix_1',
      squareRefundId: 'manual_7L1VxFA3UK0RqZZEYYMbWun61rGZY',
      amount: 100,
      reason: 'Refund processed in Square Dashboard',
      status: 'completed',
      processedAt: new Date('2025-10-11T14:35:00Z'), // Use the date from your receipt
      notes: 'Manually added - refund was $100 processed on Oct 11, 2025',
      source: 'square_dashboard',
    });

    await payment.save({ session });
    await session.commitTransaction();

    console.log('✅ MANUAL FIX COMPLETE!');
    console.log('💰 Refund added: $100');
    console.log('📊 Refund status: partial');
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
