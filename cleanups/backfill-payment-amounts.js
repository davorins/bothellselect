// cleanups/backfill-payment-amounts.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri =
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

async function backfillPaymentAmounts() {
  try {
    await mongoose.connect(uri, {});
    const db = mongoose.connection.db;

    console.log(
      '🚀 Backfilling paymentDetails.amountPaid on registrations...\n',
    );

    const registrations = db.collection('registrations');
    const payments = db.collection('payments');

    // Find paid registrations that have NO amountPaid in paymentDetails
    const broken = await registrations
      .find({
        paymentStatus: 'paid',
        $or: [
          { 'paymentDetails.amountPaid': { $exists: false } },
          { 'paymentDetails.amountPaid': 0 },
          { 'paymentDetails.amountPaid': null },
        ],
      })
      .toArray();

    console.log(
      `Found ${broken.length} paid registrations missing amountPaid\n`,
    );

    let fixed = 0;
    let skipped = 0;

    for (const reg of broken) {
      // Find a Payment for the same parent that mentions this player.
      // Most reliable match: Payment.playerIds contains reg.player,
      // OR Payment.players[].playerId contains reg.player.
      let payment = null;

      if (reg.player) {
        payment = await payments.findOne({
          parentId: reg.parent,
          $or: [{ playerIds: reg.player }, { 'players.playerId': reg.player }],
        });
      }

      // Fallback: any Payment by this parent around the registration time
      if (!payment && reg.parent) {
        const lower = new Date(
          (reg.createdAt || new Date()).getTime() - 60 * 60 * 1000, // 1h before
        );
        const upper = new Date(
          (reg.createdAt || new Date()).getTime() + 7 * 24 * 60 * 60 * 1000, // 7d after
        );
        payment = await payments.findOne(
          {
            parentId: reg.parent,
            amount: { $gt: 0 },
            createdAt: { $gte: lower, $lte: upper },
          },
          { sort: { createdAt: 1 } },
        );
      }

      if (!payment || !payment.amount) {
        skipped++;
        console.log(`⏭️  Skipped ${reg._id} — no matching payment`);
        continue;
      }

      // If one payment covers multiple players, split the amount.
      // We'll be conservative and credit the full amount once — you can
      // refine this later if needed. For now, single-player regs get the
      // full amount, multi-player regs get amount / playerCount.
      const amountToWrite = payment.amount;

      await registrations.updateOne(
        { _id: reg._id },
        {
          $set: {
            'paymentDetails.amountPaid': amountToWrite,
            'paymentDetails.paymentId': payment.paymentId || null,
            'paymentDetails.currency': 'USD',
            'paymentDetails.paymentDate': payment.createdAt || new Date(),
          },
        },
      );

      fixed++;
      console.log(
        `✅ ${reg._id}  amountPaid = $${amountToWrite}  (payment ${payment._id})`,
      );
    }

    console.log(`\n========================================`);
    console.log(`📊 BACKFILL COMPLETE`);
    console.log(`========================================`);
    console.log(`✅ Fixed:   ${fixed}`);
    console.log(`⏭️  Skipped: ${skipped}`);
    console.log(`📦 Total:   ${broken.length}`);

    // Verify
    const remaining = await registrations.countDocuments({
      paymentStatus: 'paid',
      $or: [
        { 'paymentDetails.amountPaid': { $exists: false } },
        { 'paymentDetails.amountPaid': 0 },
      ],
    });
    console.log(`\n🔍 Remaining with no amountPaid: ${remaining}`);
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Database connection closed.');
  }
}

backfillPaymentAmounts();
