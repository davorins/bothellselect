const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Payment = require('../models/Payment');
const mongoose = require('mongoose');

// Verify Square webhook signature
const verifyWebhook = (req) => {
  const signature = req.headers['x-square-hmacsha256'];
  const notificationUrl =
    'https://bothell-select.onrender.com/api/square/webhook';

  const body = req.body.toString('utf8');

  const hmac = crypto.createHmac(
    'sha256',
    process.env.SQUARE_WEBHOOK_SIGNATURE_KEY
  );
  hmac.update(notificationUrl + body);
  const hash = hmac.digest('base64');

  return hash === signature;
};

router.post('/webhook', async (req, res) => {
  try {
    // Verify webhook signature (comment out during testing)
    if (!verifyWebhook(req)) {
      return res.status(401).send('Unauthorized');
    }

    const event = req.body;

    // Handle payment completion
    if (
      event.type === 'payment.updated' &&
      event.data.object.payment.status === 'COMPLETED'
    ) {
      const squarePayment = event.data.object.payment;

      // Start a MongoDB transaction
      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        // 1. Find and update payment record
        const payment = await Payment.findOneAndUpdate(
          { paymentId: squarePayment.id },
          {
            $set: {
              status: 'completed',
              receiptUrl: squarePayment.receiptUrl,
              processedAt: new Date(),
            },
          },
          { new: true, session }
        );

        if (!payment) {
          console.log('Payment not found in database:', squarePayment.id);
          await session.abortTransaction();
          return res.status(404).send('Payment not found');
        }

        console.log(`Payment ${squarePayment.id} marked complete`);

        // 2. Update parent status
        const parentUpdate = await Parent.updateOne(
          { _id: payment.parentId },
          { $set: { paymentComplete: true } },
          { session }
        );

        console.log(
          `Updated parent ${payment.parentId} (matched ${parentUpdate.matchedCount}, modified ${parentUpdate.modifiedCount})`
        );

        // 3. Update all players for this parent
        const playersUpdate = await Player.updateMany(
          { parentId: payment.parentId }, // Changed from playerIds to parentId
          { $set: { paymentComplete: true } },
          { session }
        );

        console.log(
          `Updated ${playersUpdate.modifiedCount} players for parent ${payment.parentId}`
        );

        // Commit the transaction
        await session.commitTransaction();
        console.log('Transaction successfully committed');
      } catch (error) {
        // If any error occurs, abort the transaction
        await session.abortTransaction();
        console.error('Transaction aborted due to error:', error);
        throw error;
      } finally {
        session.endSession();
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).send('Internal Server Error');
  }
});

module.exports = router;
