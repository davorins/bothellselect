// services/payment-wrapper.js
const PaymentServiceFactory = require('./payment-service-factory');
const mongoose = require('mongoose');
const Payment = require('../models/Payment');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Registration = require('../models/Registration');
const { sendEmail } = require('../utils/email');

async function submitPayment(sourceId, amount, options = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log('💳 Unified payment wrapper called:', {
      sourceIdPrefix: sourceId?.substring(0, 20),
      amount,
      options,
    });

    // Validate
    if (!sourceId) throw new Error('Source ID is required');
    if (!amount || isNaN(amount)) throw new Error('Valid amount is required');
    if (!options.parentId) throw new Error('Parent ID is required');
    if (!options.buyerEmailAddress)
      throw new Error('Email is required for receipt');

    // Get the ACTIVE payment service (could be Square, Clover, Stripe, etc.)
    const paymentService = await PaymentServiceFactory.getService();
    console.log(`Using payment system: ${paymentService.type}`);

    // Convert amount to cents
    const amountInCents = Math.round(amount * 100);

    // Prepare payment data for the active payment system
    const paymentData = {
      sourceId,
      amount: amountInCents,
      email: options.buyerEmailAddress,
      referenceId: `parent:${options.parentId}`,
      note: options.description || 'Payment for services',
      metadata: options.metadata || {},
    };

    // Process payment
    let processedPayment;

    if (paymentService.type === 'clover') {
      // Clover requires special handling (order creation)
      const clover = require('clover-sdk');
      const cloverClient = paymentService.client;
      const ordersApi = new clover.OrdersApi(cloverClient);

      // Create order first
      const orderResponse = await ordersApi.createOrder(
        paymentService.config.merchantId,
        {
          total: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
          note: paymentData.note,
          email: paymentData.email,
          manualTransaction: false,
        },
      );

      const cloverOrder = orderResponse.data;

      // Process Clover payment
      const paymentResponse =
        await paymentService.client.PaymentsApi.createPayment(
          paymentService.config.merchantId,
          {
            orderId: cloverOrder.id,
            amount: amountInCents,
            currency: paymentService.settings?.currency || 'USD',
            source: sourceId,
            offline: false,
            tipAmount: 0,
            taxAmount: 0,
            externalPaymentId: paymentData.referenceId,
            note: paymentData.note,
          },
        );

      processedPayment = {
        ...paymentResponse.data,
        orderId: cloverOrder.id,
      };
    } else {
      // Square, Stripe, PayPal - standard processing
      processedPayment = await paymentService.processPayment(paymentData);
    }

    console.log('✅ Payment processed:', {
      paymentSystem: paymentService.type,
      paymentId: processedPayment.id,
      status: processedPayment.status,
      orderId: processedPayment.orderId,
    });

    // Check payment status
    let paymentStatus;
    if (paymentService.type === 'square') {
      paymentStatus =
        processedPayment.status === 'COMPLETED' ? 'paid' : 'failed';
    } else if (paymentService.type === 'clover') {
      paymentStatus = ['PAID', 'AUTHORIZED'].includes(processedPayment.status)
        ? 'paid'
        : 'failed';
    } else {
      paymentStatus =
        processedPayment.status === 'succeeded' ? 'paid' : 'failed';
    }

    if (paymentStatus !== 'paid') {
      throw new Error(`Payment failed with status: ${processedPayment.status}`);
    }

    // Store payment in database
    const paymentRecord = new Payment({
      playerIds: options.playerIds || [],
      parentId: options.parentId,
      paymentId: processedPayment.id,
      orderId: processedPayment.orderId,
      paymentSystem: paymentService.type,
      configurationId: paymentService.configurationId,
      amount: amount / 100, // Convert cents to dollars
      status: paymentStatus,
      cardLastFour:
        options.cardDetails?.last_4 || processedPayment.card?.last4 || '1111',
      cardBrand:
        options.cardDetails?.card_brand ||
        processedPayment.card?.type ||
        'UNKNOWN',
      cardExpMonth: options.cardDetails?.exp_month || '00',
      cardExpYear: options.cardDetails?.exp_year || '00',
      buyerEmail: options.buyerEmailAddress,
      players: (options.playerIds || []).map((id) => ({
        playerId: id,
        season: options.season,
        year: options.year,
        tryoutId: options.tryoutId,
      })),
      metadata: {
        ...options.metadata,
        paymentSystem: paymentService.type,
        ...(paymentService.type === 'square' && {
          locationId: paymentService.config.locationId,
        }),
        ...(paymentService.type === 'clover' && {
          merchantId: paymentService.config.merchantId,
        }),
      },
    });

    await paymentRecord.save({ session });

    // Update parent
    await Parent.updateOne(
      { _id: options.parentId },
      {
        $set: {
          paymentComplete: true,
          lastPaymentDate: new Date(),
        },
        $push: { payments: paymentRecord._id },
      },
      { session },
    );

    // Update players if specified
    if (options.playerIds && options.playerIds.length > 0) {
      await Promise.all([
        Player.updateMany(
          { _id: { $in: options.playerIds } },
          {
            $set: {
              paymentComplete: true,
              paymentStatus: 'paid',
            },
            $push: {
              seasons: {
                season: options.season,
                year: options.year,
                tryoutId: options.tryoutId,
                paymentStatus: 'paid',
                paymentDate: new Date(),
                paymentId: paymentRecord._id,
              },
            },
          },
          { session },
        ),
        Registration.updateMany(
          {
            player: { $in: options.playerIds },
            season: options.season,
            year: options.year,
            tryoutId: options.tryoutId,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentDate: new Date(),
              paymentId: paymentRecord._id,
            },
          },
          { session },
        ),
      ]);
    }

    // Send receipt email
    try {
      await sendEmail({
        to: options.buyerEmailAddress,
        subject: `Payment Confirmation - ${paymentService.type.charAt(0).toUpperCase() + paymentService.type.slice(1)} Payment`,
        html: `
          <h2>Payment Successful</h2>
          <p>Payment System: ${paymentService.type}</p>
          <p>Amount: $${(amount / 100).toFixed(2)}</p>
          ${options.playerIds?.length > 0 ? `<p>Players: ${options.playerIds.length}</p>` : ''}
          <p>Payment ID: ${processedPayment.id}</p>
          ${processedPayment.orderId ? `<p>Order ID: ${processedPayment.orderId}</p>` : ''}
          <p>Date: ${new Date().toLocaleDateString()}</p>
          <p>Status: ${processedPayment.status}</p>
        `,
      });
    } catch (emailError) {
      console.warn('⚠️ Email sending failed:', emailError.message);
    }

    await session.commitTransaction();

    console.log('✅ Payment completed successfully:', {
      paymentId: paymentRecord._id,
      externalId: processedPayment.id,
      paymentSystem: paymentService.type,
      amount: amount / 100,
    });

    return {
      success: true,
      payment: {
        id: paymentRecord._id,
        externalId: processedPayment.id,
        orderId: processedPayment.orderId,
        amount: amount / 100,
        status: processedPayment.status,
        paymentSystem: paymentService.type,
        playersUpdated: options.playerIds?.length || 0,
        parentUpdated: true,
        receiptUrl: processedPayment.receiptUrl || processedPayment.receipt_url,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('❌ Payment processing failed:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

async function processRefund(paymentId, amount, options = {}) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log('🔄 Unified refund processing:', {
      paymentId,
      amount,
      options,
    });

    if (!paymentId) throw new Error('Payment ID is required');
    if (!amount || amount <= 0)
      throw new Error('Valid refund amount is required');

    // Find payment record
    const paymentRecord = await Payment.findOne({
      $or: [{ paymentId: paymentId }, { _id: paymentId }],
    }).session(session);

    if (!paymentRecord) {
      throw new Error(`Payment record not found: ${paymentId}`);
    }

    // Get the payment service used for this payment
    const paymentService = await PaymentServiceFactory.getService(
      paymentRecord.paymentSystem,
    );

    console.log(
      `Processing refund through ${paymentRecord.paymentSystem} for payment:`,
      {
        dbId: paymentRecord._id,
        paymentSystemId: paymentRecord.paymentId,
        amount: paymentRecord.amount,
      },
    );

    // Calculate refund amount in cents
    const amountInCents = Math.round(amount * 100);
    const previouslyRefunded = paymentRecord.refundedAmount || 0;
    const availableForRefund = paymentRecord.amount - previouslyRefunded;

    if (amount > availableForRefund) {
      throw new Error(
        `Maximum refund amount available: $${availableForRefund.toFixed(2)}`,
      );
    }

    // Process refund
    let refundResult;
    if (paymentService.type === 'clover') {
      const refundsApi = new (require('clover-sdk').RefundsApi)(
        paymentService.client,
      );
      const refundResponse = await refundsApi.createRefund(
        paymentService.config.merchantId,
        {
          paymentId: paymentRecord.paymentId,
          amount: amountInCents,
          reason: options.reason || 'Customer request',
        },
      );
      refundResult = refundResponse.data;
    } else {
      refundResult = await paymentService.refundPayment(
        paymentRecord.paymentId,
        amountInCents,
        options.reason || 'Customer request',
      );
    }

    // Update payment record
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
      refundId: refundResult.id,
      amount: amount,
      reason: options.reason || 'Customer request',
      status: refundResult.status,
      processedAt: new Date(),
      externalRefundId: refundResult.id,
    });

    await paymentRecord.save({ session });

    // Update parent and players if full refund
    if (isFullRefund && paymentRecord.parentId) {
      await Parent.updateOne(
        { _id: paymentRecord.parentId },
        { $set: { paymentComplete: false } },
        { session },
      );

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
                  refundId: refundResult.id,
                  amount: amount,
                  paymentId: paymentRecord._id,
                  refundDate: new Date(),
                },
              },
            },
            { session },
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
            { session },
          ),
        ]);
      }
    }

    // Send refund confirmation email
    if (paymentRecord.buyerEmail) {
      await sendEmail({
        to: paymentRecord.buyerEmail,
        subject: 'Refund Processed',
        html: `
          <h2>Refund Processed</h2>
          <p>Original Payment Amount: $${paymentRecord.amount.toFixed(2)}</p>
          <p>Refund Amount: $${amount.toFixed(2)}</p>
          <p>Refund Reason: ${options.reason || 'Customer request'}</p>
          <p>Refund ID: ${refundResult.id}</p>
          <p>Original Payment ID: ${paymentRecord.paymentId}</p>
          <p>Date: ${new Date().toLocaleDateString()}</p>
          <p><strong>Note:</strong> Refunds typically take 5-10 business days to appear on your original payment method.</p>
        `,
      });
    }

    await session.commitTransaction();

    return {
      success: true,
      refund: {
        id: refundResult.id,
        amount: amount,
        status: refundResult.status,
        reason: options.reason,
        paymentId: paymentRecord.paymentId,
        isFullRefund,
        isPartialRefund,
      },
    };
  } catch (error) {
    await session.abortTransaction();
    console.error('Refund processing failed:', error);
    throw error;
  } finally {
    session.endSession();
  }
}

async function getPaymentDetails(paymentId) {
  try {
    // Find payment in database
    const paymentRecord = await Payment.findOne({
      $or: [{ paymentId: paymentId }, { _id: paymentId }],
    });

    if (!paymentRecord) {
      throw new Error('Payment record not found');
    }

    // Get payment service for this payment
    const paymentService = await PaymentServiceFactory.getService(
      paymentRecord.paymentSystem,
    );

    // Get live details from payment processor
    let liveDetails;
    try {
      liveDetails = await paymentService.getPaymentDetails(
        paymentRecord.paymentId,
      );
    } catch (error) {
      console.warn('Could not fetch live payment details:', error.message);
      liveDetails = null;
    }

    return {
      ...paymentRecord.toObject(),
      liveDetails,
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
};
