// services/syncRefunds.js - DEBUG REFUNDS VERSION
const mongoose = require('mongoose');
const { Client, Environment } = require('square');
const Payment = require('../models/Payment');
require('dotenv').config();

const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

const { paymentsApi, refundsApi } = client;

async function getAllSquareRefunds() {
  try {
    console.log('🔄 Getting ALL refunds from Square...');
    const { result } = await refundsApi.listPaymentRefunds();
    const allRefunds = result.refunds || [];

    console.log(`📊 Found ${allRefunds.length} total refunds in Square:`);
    allRefunds.forEach((refund, index) => {
      console.log(`   ${index + 1}. Refund ID: ${refund.id}`);
      console.log(`      Payment ID: ${refund.paymentId}`);
      console.log(`      Amount: $${Number(refund.amountMoney.amount) / 100}`);
      console.log(`      Status: ${refund.status}`);
      console.log(`      Reason: ${refund.reason}`);
      console.log(`      Processed: ${refund.processedAt}`);
    });

    return allRefunds;
  } catch (error) {
    console.log(`❌ Error getting all refunds: ${error.message}`);
    return [];
  }
}

async function syncRefundsForPayment(squarePaymentId) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log(`🔍 Syncing refunds for payment: ${squarePaymentId}`);

    // Find the payment in MongoDB
    const paymentRecord = await Payment.findOne({
      paymentId: squarePaymentId,
    }).session(session);

    if (!paymentRecord) {
      console.log(
        `❌ Payment record not found for Square payment ID: ${squarePaymentId}`
      );
      return { success: false, error: 'Payment record not found' };
    }

    console.log(`✅ Found payment in MongoDB: ${paymentRecord._id}`);

    // Get all refunds and filter for this payment
    const allRefunds = await getAllSquareRefunds();
    const squareRefunds = allRefunds.filter(
      (refund) => refund.paymentId === squarePaymentId
    );

    console.log(
      `🎯 Found ${squareRefunds.length} refunds for payment ${squarePaymentId}`
    );

    let totalRefunded = paymentRecord.refundedAmount || 0;
    let newRefundsAdded = 0;

    // Process each refund from Square
    for (const squareRefund of squareRefunds) {
      // Skip if refund already exists in our database
      const existingRefund = paymentRecord.refunds?.find(
        (refund) => refund.squareRefundId === squareRefund.id
      );

      if (existingRefund) {
        console.log(`⏩ Refund ${squareRefund.id} already exists in database`);
        continue;
      }

      // Convert amount from cents to dollars
      const refundAmount = Number(squareRefund.amountMoney.amount) / 100;

      // Create new refund record
      const newRefund = {
        refundId: `sq_${squareRefund.id}`,
        squareRefundId: squareRefund.id,
        amount: refundAmount,
        reason: squareRefund.reason || 'Processed in Square Dashboard',
        status: mapSquareRefundStatus(squareRefund.status),
        processedAt: new Date(
          squareRefund.processedAt || squareRefund.createdAt
        ),
        notes: 'Synced from Square Dashboard',
        source: 'square_dashboard',
      };

      // Add to payment's refunds array
      if (!paymentRecord.refunds) {
        paymentRecord.refunds = [];
      }

      paymentRecord.refunds.push(newRefund);
      totalRefunded += refundAmount;
      newRefundsAdded++;

      console.log(
        `✅ Added refund ${squareRefund.id} for amount $${refundAmount}`
      );
    }

    // Update payment record
    paymentRecord.refundedAmount = totalRefunded;

    // Update refund status
    if (totalRefunded >= paymentRecord.amount) {
      paymentRecord.refundStatus = 'full';
    } else if (totalRefunded > 0) {
      paymentRecord.refundStatus = 'partial';
    } else {
      paymentRecord.refundStatus = 'none';
    }

    await paymentRecord.save({ session });
    await session.commitTransaction();

    console.log(
      `🎉 Successfully synced ${newRefundsAdded} new refunds for payment ${squarePaymentId}`
    );
    console.log(`💰 Total refunded: $${totalRefunded}`);

    return {
      success: true,
      refundsProcessed: newRefundsAdded,
      totalRefunded,
      paymentId: paymentRecord._id,
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Error syncing refunds:', error);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    session.endSession();
  }
}

function mapSquareRefundStatus(squareStatus) {
  const statusMap = {
    PENDING: 'pending',
    COMPLETED: 'completed',
    REJECTED: 'failed',
    FAILED: 'failed',
  };
  return statusMap[squareStatus] || 'completed';
}

async function syncAllRefunds() {
  try {
    console.log('🔄 Starting refund sync for all payments...');

    // First, let's see what refunds actually exist in Square
    await getAllSquareRefunds();

    const payments = await Payment.find({
      status: 'completed',
      $or: [
        { refundStatus: { $in: ['none', 'partial'] } },
        { refundStatus: { $exists: false } },
      ],
    });

    console.log(`📋 Found ${payments.length} payments to check for refunds`);

    let totalSynced = 0;
    let totalRefunded = 0;

    for (const payment of payments) {
      const result = await syncRefundsForPayment(payment.paymentId);

      if (result.success) {
        totalSynced += result.refundsProcessed;
        totalRefunded += result.totalRefunded;
        console.log(
          `✅ ${payment.paymentId}: ${result.refundsProcessed} refunds`
        );
      } else {
        console.log(`❌ ${payment.paymentId}: ${result.error}`);
      }

      // Add delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    console.log(`🎊 Refund sync completed!`);
    console.log(`📈 Total refunds synced: ${totalSynced}`);
    console.log(`💰 Total amount refunded: $${totalRefunded}`);

    return {
      success: true,
      totalPaymentsProcessed: payments.length,
      totalRefundsSynced: totalSynced,
      totalAmountRefunded: totalRefunded,
    };
  } catch (error) {
    console.error('❌ Error in syncAllRefunds:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

async function findRefundsForUnknownPayments() {
  try {
    console.log(
      '🔍 Looking for refunds that might belong to unknown payments...'
    );

    const allRefunds = await getAllSquareRefunds();
    const allPaymentIds = allRefunds.map((refund) => refund.paymentId);

    console.log(
      `📊 Unique payment IDs from refunds: ${[...new Set(allPaymentIds)].join(', ')}`
    );

    // Check which payment IDs we have in our database
    const paymentsInDb = await Payment.find({
      paymentId: { $in: allPaymentIds },
    });

    const paymentIdsInDb = paymentsInDb.map((p) => p.paymentId);
    const unknownPaymentIds = allPaymentIds.filter(
      (id) => !paymentIdsInDb.includes(id)
    );

    console.log(
      `❓ Unknown payment IDs (not in our database): ${unknownPaymentIds.join(', ')}`
    );

    return {
      totalRefunds: allRefunds.length,
      uniquePaymentIds: [...new Set(allPaymentIds)],
      unknownPaymentIds,
      paymentsInDb: paymentIdsInDb,
    };
  } catch (error) {
    console.error('❌ Error finding unknown payments:', error);
    return { error: error.message };
  }
}

async function syncRefundsByDateRange(startDate, endDate) {
  try {
    console.log(`📅 Syncing refunds between ${startDate} and ${endDate}`);

    const payments = await Payment.find({
      status: 'completed',
      createdAt: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    });

    console.log(`📋 Found ${payments.length} payments in date range`);

    let processed = 0;
    let errors = 0;

    for (const payment of payments) {
      try {
        const result = await syncRefundsForPayment(payment.paymentId);

        if (result.success) {
          processed += result.refundsProcessed || 0;
          console.log(
            `✅ ${payment.paymentId}: ${result.refundsProcessed} refunds synced`
          );
        } else {
          errors++;
          console.log(`❌ ${payment.paymentId}: ${result.error}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        errors++;
        console.log(
          `💥 Error processing payment ${payment.paymentId}:`,
          error.message
        );
      }
    }

    console.log(`🎊 Date range sync completed!`);
    console.log(`📈 Successfully processed: ${processed} refunds`);
    console.log(`❌ Errors: ${errors}`);

    return {
      success: true,
      processed,
      errors,
      totalPayments: payments.length,
    };
  } catch (error) {
    console.error('❌ Error in syncRefundsByDateRange:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

module.exports = {
  syncRefundsForPayment,
  syncAllRefunds,
  syncRefundsByDateRange,
  findRefundsForUnknownPayments,
  getAllSquareRefunds,
};
