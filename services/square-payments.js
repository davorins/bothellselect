const { Client, Environment } = require('square');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Registration = require('../models/Registration');
require('dotenv').config();
const { sendEmail } = require('../utils/email');

// Initialize Square Client
const client = new Client({
  accessToken: process.env.SQUARE_ACCESS_TOKEN,
  environment:
    process.env.NODE_ENV === 'production'
      ? Environment.Production
      : Environment.Sandbox,
});

const { paymentsApi, customersApi, refundsApi } = client;

async function submitPayment(
  sourceId,
  amount,
  {
    parentId,
    playerIds = [],
    season,
    year,
    tryoutId,
    cardDetails,
    buyerEmailAddress,
    description = 'Form submission payment',
  }
) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate minimum requirements
    if (!sourceId) throw new Error('Source ID is required');
    if (!amount || isNaN(amount)) throw new Error('Valid amount is required');
    if (!parentId) throw new Error('Parent ID is required');
    if (!buyerEmailAddress) throw new Error('Email is required for receipt');
    if (!cardDetails?.last_4) throw new Error('Card details incomplete');
    if (!Array.isArray(playerIds))
      throw new Error('Player IDs must be an array');
    if (!process.env.SQUARE_LOCATION_ID)
      throw new Error('Square location ID not configured');

    // Validate player IDs if provided
    if (playerIds.length > 0) {
      const validPlayers = await Player.countDocuments({
        _id: { $in: playerIds },
        parentId,
      }).session(session);

      if (validPlayers !== playerIds.length) {
        throw new Error(
          'One or more players not found or do not belong to parent'
        );
      }
    }

    // Create or find Square customer
    const { result: customerResult } = await customersApi.createCustomer({
      emailAddress: buyerEmailAddress,
      idempotencyKey: randomUUID(),
    });
    const customerId = customerResult.customer?.id;
    if (!customerId) throw new Error('Failed to create customer record');

    // Create payment request
    const paymentRequest = {
      idempotencyKey: randomUUID(),
      sourceId,
      amountMoney: {
        amount: amount,
        currency: 'USD',
      },
      customerId,
      locationId: process.env.SQUARE_LOCATION_ID, // Always use from env
      autocomplete: true,
      referenceId: `parent:${parentId}`,
      note:
        playerIds.length > 0
          ? `Payment for ${playerIds.length} player(s)`
          : description,
      buyerEmailAddress,
    };

    // Process payment with Square
    const { result } = await paymentsApi.createPayment(paymentRequest);
    const squarePayment = result.payment;

    if (!squarePayment || squarePayment.status !== 'COMPLETED') {
      throw new Error(`Payment failed with status: ${squarePayment?.status}`);
    }

    // Store payment details
    const paymentRecord = new Payment({
      playerIds,
      parentId,
      paymentId: squarePayment.id,
      amount: amount / 100,
      status: squarePayment.status.toLowerCase(),
      receiptUrl: squarePayment.receiptUrl,
      cardLastFour: cardDetails.last_4,
      cardBrand: cardDetails.card_brand || 'UNKNOWN',
      cardExpMonth: cardDetails.exp_month || '00',
      cardExpYear: cardDetails.exp_year || '00',
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmail: buyerEmailAddress,
      players: playerIds.map((id) => ({
        playerId: id,
        season,
        year,
        tryoutId,
      })),
    });

    await paymentRecord.save({ session });

    // Update parent payment status
    await Parent.updateOne(
      { _id: parentId },
      {
        $set: {
          paymentComplete: true,
          lastPaymentDate: new Date(),
        },
        $push: { payments: paymentRecord._id },
      },
      { session }
    );

    // Update players if specified
    if (playerIds.length > 0) {
      await Promise.all([
        // Update player documents
        Player.updateMany(
          { _id: { $in: playerIds } },
          {
            $set: {
              paymentComplete: true,
              paymentStatus: 'paid',
            },
            $push: {
              seasons: {
                season,
                year,
                tryoutId,
                paymentStatus: 'paid',
                paymentDate: new Date(),
                paymentId: paymentRecord._id,
              },
            },
          },
          { session }
        ),
        // Update registrations
        Registration.updateMany(
          {
            player: { $in: playerIds },
            season,
            year,
            tryoutId,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentDate: new Date(),
              paymentId: paymentRecord._id,
            },
          },
          { session }
        ),
      ]);
    }

    // Send receipt email
    await sendEmail({
      to: buyerEmailAddress,
      subject: 'Payment Confirmation - Basketball Camp',
      html: `
        <h2>Payment Successful</h2>
        <p>Amount: $${(amount / 100).toFixed(2)}</p>
        ${playerIds.length > 0 ? `<p>Players: ${playerIds.length}</p>` : ''}
        <p>Payment ID: ${squarePayment.id}</p>
        <p>Date: ${new Date().toLocaleDateString()}</p>
        <p><a href="${squarePayment.receiptUrl}">View Receipt</a></p>
      `,
    });

    await session.commitTransaction();

    return {
      success: true,
      payment: {
        id: paymentRecord._id,
        squareId: squarePayment.id,
        amount: amount / 100,
        status: squarePayment.status,
        receiptUrl: squarePayment.receiptUrl,
        playersUpdated: playerIds.length,
        parentUpdated: true,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment processing failed:', {
      error: error.message,
      stack: error.stack,
      parentId,
      playerIds,
    });
    throw error; // Re-throw the original error to preserve stack trace
  } finally {
    session.endSession();
  }
}

// REFUND FUNCTIONALITY
async function processRefund(
  paymentId,
  amount,
  { reason = 'Customer request', parentId, refundAll = false }
) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Validate inputs
    if (!paymentId) throw new Error('Payment ID is required');
    if (!amount || amount <= 0)
      throw new Error('Valid refund amount is required');
    if (!process.env.SQUARE_LOCATION_ID)
      throw new Error('Square location ID not configured');

    // Find the payment record
    const paymentRecord = await Payment.findOne({
      $or: [{ paymentId: paymentId }, { _id: paymentId }],
    }).session(session);

    if (!paymentRecord) {
      throw new Error('Payment record not found');
    }

    // Check if payment is already refunded
    if (paymentRecord.refundStatus === 'refunded') {
      throw new Error('Payment has already been fully refunded');
    }

    if (paymentRecord.refundStatus === 'partially_refunded' && refundAll) {
      throw new Error(
        'Payment has already been partially refunded. Please process partial refund instead.'
      );
    }

    // Calculate refund amount
    const amountInCents = Math.round(amount * 100);
    const originalAmountInCents = Math.round(paymentRecord.amount * 100);

    // Validate refund amount doesn't exceed original amount
    if (amountInCents > originalAmountInCents) {
      throw new Error('Refund amount cannot exceed original payment amount');
    }

    // Check if partial refund is allowed
    const previouslyRefunded = paymentRecord.refundedAmount || 0;
    const availableForRefund = paymentRecord.amount - previouslyRefunded;

    if (amount > availableForRefund) {
      throw new Error(
        `Maximum refund amount available: $${availableForRefund.toFixed(2)}`
      );
    }

    // Process refund with Square
    const idempotencyKey = randomUUID();

    const refundRequest = {
      idempotencyKey,
      paymentId: paymentRecord.paymentId,
      amountMoney: {
        amount: amountInCents,
        currency: 'USD',
      },
      reason,
    };

    const { result } = await refundsApi.refundPayment(refundRequest);
    const squareRefund = result.refund;

    if (!squareRefund) {
      throw new Error('Square refund response invalid');
    }

    // Update payment record with refund details
    const newRefundedAmount = previouslyRefunded + amount;
    const isFullRefund = newRefundedAmount >= paymentRecord.amount;
    const isPartialRefund =
      newRefundedAmount > 0 && newRefundedAmount < paymentRecord.amount;

    paymentRecord.refundedAmount = newRefundedAmount;
    paymentRecord.refundStatus = isFullRefund
      ? 'refunded'
      : isPartialRefund
        ? 'partially_refunded'
        : paymentRecord.refundStatus;
    paymentRecord.refunds = paymentRecord.refunds || [];
    paymentRecord.refunds.push({
      refundId: squareRefund.id,
      amount: amount,
      reason: reason,
      status: squareRefund.status,
      processedAt: new Date(),
      squareRefundId: squareRefund.id,
    });

    await paymentRecord.save({ session });

    // Update parent and player payment status if this is a full refund
    if (isFullRefund && parentId) {
      await Parent.updateOne(
        { _id: parentId },
        {
          $set: {
            paymentComplete: false,
          },
        },
        { session }
      );

      // Update players if this payment was for players
      if (paymentRecord.playerIds && paymentRecord.playerIds.length > 0) {
        await Promise.all([
          Player.updateMany(
            { _id: { $in: paymentRecord.playerIds } },
            {
              $set: {
                paymentComplete: false,
                paymentStatus: 'refunded',
              },
              $push: {
                refunds: {
                  refundId: squareRefund.id,
                  amount: amount,
                  paymentId: paymentRecord._id,
                  refundDate: new Date(),
                },
              },
            },
            { session }
          ),
          Registration.updateMany(
            {
              player: { $in: paymentRecord.playerIds },
              paymentId: paymentRecord._id,
            },
            {
              $set: {
                paymentStatus: 'refunded',
                paymentComplete: false,
              },
            },
            { session }
          ),
        ]);
      }
    }

    // Send refund confirmation email
    if (paymentRecord.buyerEmail) {
      await sendEmail({
        to: paymentRecord.buyerEmail,
        subject: 'Refund Processed - Basketball Camp',
        html: `
          <h2>Refund Processed</h2>
          <p>Original Payment Amount: $${paymentRecord.amount.toFixed(2)}</p>
          <p>Refund Amount: $${amount.toFixed(2)}</p>
          <p>Refund Reason: ${reason}</p>
          <p>Refund ID: ${squareRefund.id}</p>
          <p>Date: ${new Date().toLocaleDateString()}</p>
          <p><strong>Note:</strong> Refunds typically take 5-10 business days to appear on your original payment method.</p>
        `,
      });
    }

    await session.commitTransaction();

    return {
      success: true,
      refund: {
        id: squareRefund.id,
        amount: amount,
        status: squareRefund.status,
        reason: reason,
        paymentId: paymentRecord.paymentId,
        isFullRefund,
        isPartialRefund,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Refund processing failed:', {
      error: error.message,
      stack: error.stack,
      paymentId,
      amount,
    });

    // Handle Square-specific errors
    if (error.errors) {
      const squareError = error.errors[0];
      switch (squareError.code) {
        case 'REFUND_ALREADY_PENDING':
          throw new Error('A refund for this payment is already in progress');
        case 'REFUND_ALREADY_COMPLETED':
          throw new Error('This payment has already been refunded');
        case 'INSUFFICIENT_PERMISSIONS':
          throw new Error('Refund permission denied. Please contact support.');
        case 'PAYMENT_NOT_FOUND':
          throw new Error('Payment not found in Square system');
        case 'INVALID_AMOUNT':
          throw new Error('Invalid refund amount specified');
        default:
          throw new Error(
            squareError.detail || 'Square refund processing failed'
          );
      }
    }

    throw error;
  } finally {
    session.endSession();
  }
}

// Get payment details for refund validation
async function getPaymentDetails(paymentId) {
  try {
    const paymentRecord = await Payment.findOne({
      $or: [{ paymentId: paymentId }, { _id: paymentId }],
    });

    if (!paymentRecord) {
      throw new Error('Payment record not found');
    }

    return {
      paymentId: paymentRecord.paymentId,
      amount: paymentRecord.amount,
      refundedAmount: paymentRecord.refundedAmount || 0,
      availableForRefund:
        paymentRecord.amount - (paymentRecord.refundedAmount || 0),
      refundStatus: paymentRecord.refundStatus,
      buyerEmail: paymentRecord.buyerEmail,
      cardLastFour: paymentRecord.cardLastFour,
      createdAt: paymentRecord.createdAt,
    };
  } catch (error) {
    console.error('Error getting payment details:', error);
    throw error;
  }
}

module.exports = {
  submitPayment,
  processRefund,
  getPaymentDetails,
  client,
};
