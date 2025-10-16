// services/syncRefunds.js - UPDATED FOR SQUARE SDK v34+
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

    // Get refunds from Square - USING POSITIONAL PARAMETERS
    let squareRefunds = [];
    try {
      const { result } = await refundsApi.listPaymentRefunds(
        undefined, // cursor
        undefined, // locationId
        undefined, // status
        squarePaymentId, // paymentId - 4th parameter
        undefined, // beginTime
        undefined, // endTime
        undefined, // sortOrder
        undefined // limit
      );
      squareRefunds = result.refunds || [];
      console.log(`📋 Found ${squareRefunds.length} refunds by paymentId`);
    } catch (error) {
      console.log(`❌ Error getting refunds by paymentId: ${error.message}`);
    }

    // If no refunds found, try getting all refunds with date range
    if (squareRefunds.length === 0) {
      try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const { result } = await refundsApi.listPaymentRefunds(
          undefined, // cursor
          undefined, // locationId
          undefined, // status
          undefined, // paymentId
          thirtyDaysAgo.toISOString(), // beginTime - 5th parameter
          new Date().toISOString(), // endTime - 6th parameter
          undefined, // sortOrder
          100 // limit - 8th parameter
        );

        const allRefunds = result.refunds || [];
        squareRefunds = allRefunds.filter(
          (refund) => refund.paymentId === squarePaymentId
        );
        console.log(
          `📋 Found ${squareRefunds.length} refunds by filtering all refunds`
        );
      } catch (error) {
        console.log(`❌ Error filtering all refunds: ${error.message}`);
      }
    }

    console.log(`🎯 Total refunds to process: ${squareRefunds.length}`);

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

      // Convert amount from cents to dollars - handle BigInt
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

      await new Promise((resolve) => setTimeout(resolve, 200));
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

async function syncRefundsByDateRange(startDate, endDate) {
  try {
    console.log(`📅 Syncing refunds between ${startDate} and ${endDate}`);

    const { result } = await refundsApi.listPaymentRefunds({
      beginTime: new Date(startDate).toISOString(),
      endTime: new Date(endDate).toISOString(),
      limit: 100,
    });

    const refunds = result.refunds || [];
    console.log(
      `✅ Found ${refunds.length} refunds in Square for the date range`
    );

    let processed = 0;
    let errors = 0;

    // Group refunds by payment ID
    const refundsByPayment = {};
    refunds.forEach((refund) => {
      if (!refundsByPayment[refund.paymentId]) {
        refundsByPayment[refund.paymentId] = [];
      }
      refundsByPayment[refund.paymentId].push(refund);
    });

    console.log(
      `📊 Processing refunds for ${Object.keys(refundsByPayment).length} unique payments`
    );

    for (const [paymentId, paymentRefunds] of Object.entries(
      refundsByPayment
    )) {
      try {
        const result = await syncRefundsForPayment(paymentId);

        if (result.success) {
          processed += result.refundsProcessed || 0;
          console.log(
            `✅ ${paymentId}: ${result.refundsProcessed} refunds synced`
          );
        } else {
          errors++;
          console.log(`❌ ${paymentId}: ${result.error}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch (error) {
        errors++;
        console.log(`💥 Error processing payment ${paymentId}:`, error.message);
      }
    }

    console.log(`🎊 Date range sync completed!`);
    console.log(`📈 Successfully processed: ${processed} refunds`);
    console.log(`❌ Errors: ${errors}`);

    return {
      success: true,
      processed,
      errors,
      totalPayments: Object.keys(refundsByPayment).length,
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
};
