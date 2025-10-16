const mongoose = require('mongoose');
const { Client, Environment } = require('square');
const Payment = require('../models/Payment');
require('dotenv').config();

// Initialize Square Client
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
    console.log(`Syncing refunds for payment: ${squarePaymentId}`);

    // Find the payment in MongoDB
    const paymentRecord = await Payment.findOne({
      paymentId: squarePaymentId,
    }).session(session);

    if (!paymentRecord) {
      console.log(
        `Payment record not found for Square payment ID: ${squarePaymentId}`
      );
      return { success: false, error: 'Payment record not found' };
    }

    // Get refunds from Square
    const { result } = await refundsApi.listPaymentRefunds({
      paymentId: squarePaymentId,
    });

    const squareRefunds = result.refunds || [];
    console.log(
      `Found ${squareRefunds.length} refunds in Square for payment ${squarePaymentId}`
    );

    let totalRefunded = 0;
    const processedRefundIds = new Set();

    // Process each refund from Square
    for (const squareRefund of squareRefunds) {
      // Skip if refund already exists in our database
      const existingRefund = paymentRecord.refunds?.find(
        (refund) => refund.squareRefundId === squareRefund.id
      );

      if (existingRefund) {
        console.log(`Refund ${squareRefund.id} already exists in database`);
        processedRefundIds.add(squareRefund.id);
        totalRefunded += existingRefund.amount;
        continue;
      }

      // Convert amount from cents to dollars
      const refundAmount = squareRefund.amountMoney.amount / 100;

      // Create new refund record
      const newRefund = {
        refundId: `sync_${squareRefund.id}`,
        squareRefundId: squareRefund.id,
        amount: refundAmount,
        reason: squareRefund.reason || 'Processed in Square Dashboard',
        status: squareRefund.status.toLowerCase(),
        processedAt: new Date(
          squareRefund.processedAt || squareRefund.createdAt
        ),
        notes: 'Synced from Square Dashboard',
      };

      // Add to payment's refunds array
      if (!paymentRecord.refunds) {
        paymentRecord.refunds = [];
      }

      paymentRecord.refunds.push(newRefund);
      processedRefundIds.add(squareRefund.id);
      totalRefunded += refundAmount;

      console.log(
        `Added refund ${squareRefund.id} for amount $${refundAmount}`
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
      `Successfully synced ${processedRefundIds.size} refunds for payment ${squarePaymentId}`
    );
    console.log(`Total refunded: $${totalRefunded}`);

    return {
      success: true,
      refundsProcessed: processedRefundIds.size,
      totalRefunded,
      paymentId: paymentRecord._id,
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Error syncing refunds:', error);
    return {
      success: false,
      error: error.message,
    };
  } finally {
    session.endSession();
  }
}

// Sync refunds for all payments that might have refunds
async function syncAllRefunds() {
  try {
    console.log('Starting refund sync for all payments...');

    // Find payments that might have refunds (completed payments)
    const payments = await Payment.find({
      status: 'completed',
      $or: [
        { refundStatus: { $in: ['none', 'partial'] } },
        { refundStatus: { $exists: false } },
      ],
    });

    console.log(`Found ${payments.length} payments to check for refunds`);

    let totalSynced = 0;
    let totalRefunded = 0;

    for (const payment of payments) {
      const result = await syncRefundsForPayment(payment.paymentId);

      if (result.success) {
        totalSynced += result.refundsProcessed;
        totalRefunded += result.totalRefunded;
        console.log(
          `Synced payment ${payment.paymentId}: ${result.refundsProcessed} refunds`
        );
      } else {
        console.log(
          `Failed to sync payment ${payment.paymentId}: ${result.error}`
        );
      }

      // Small delay to avoid rate limiting
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(`Refund sync completed!`);
    console.log(`Total refunds synced: ${totalSynced}`);
    console.log(`Total amount refunded: $${totalRefunded}`);

    return {
      success: true,
      totalPaymentsProcessed: payments.length,
      totalRefundsSynced: totalSynced,
      totalAmountRefunded: totalRefunded,
    };
  } catch (error) {
    console.error('Error in syncAllRefunds:', error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Sync refunds for a specific date range
async function syncRefundsByDateRange(startDate, endDate) {
  try {
    console.log(`Syncing refunds between ${startDate} and ${endDate}`);

    const { result } = await refundsApi.listPaymentRefunds({
      beginTime: startDate,
      endTime: endDate,
    });

    const refunds = result.refunds || [];
    console.log(`Found ${refunds.length} refunds in Square for the date range`);

    let processed = 0;
    let errors = 0;

    for (const refund of refunds) {
      const result = await syncRefundsForPayment(refund.paymentId);

      if (result.success) {
        processed++;
        console.log(`Processed refund for payment ${refund.paymentId}`);
      } else {
        errors++;
        console.log(
          `Failed to process refund for payment ${refund.paymentId}: ${result.error}`
        );
      }

      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    console.log(
      `Date range sync completed: ${processed} processed, ${errors} errors`
    );

    return {
      success: true,
      processed,
      errors,
    };
  } catch (error) {
    console.error('Error in syncRefundsByDateRange:', error);
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
