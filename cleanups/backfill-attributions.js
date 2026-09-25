// backfill-attributions.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri =
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

async function backfillAttributions() {
  try {
    await mongoose.connect(uri, {});
    const db = mongoose.connection.db;

    console.log('🚀 Starting attribution backfill...\n');

    const attributions = db.collection('marketingattributions');
    const registrations = db.collection('registrations');

    // Find attributions missing registrationId
    const broken = await attributions
      .find({
        $or: [{ registrationId: { $exists: false } }, { registrationId: null }],
      })
      .toArray();

    console.log(`Found ${broken.length} attributions missing registrationId\n`);

    let fixed = 0;
    let skipped = 0;

    for (const attr of broken) {
      if (!attr.parentId) {
        skipped++;
        continue;
      }

      // Find the earliest registration for this parent, within 5 minutes
      // before the attribution, or any time after.
      const earliestBound = new Date(
        (attr.firstTouchAt || attr.createdAt || new Date()).getTime() -
          5 * 60 * 1000,
      );

      const reg = await registrations.findOne(
        {
          parent: attr.parentId,
          createdAt: { $gte: earliestBound },
        },
        { sort: { createdAt: 1 } },
      );

      if (!reg) {
        skipped++;
        console.log(`⏭️  Skipped ${attr._id} — no matching registration`);
        continue;
      }

      await attributions.updateOne(
        { _id: attr._id },
        {
          $set: {
            registrationId: reg._id,
            registrationAt: reg.createdAt,
          },
        },
      );

      fixed++;
      console.log(`✅ Linked ${attr._id} → registration ${reg._id}`);
    }

    console.log(`\n========================================`);
    console.log(`📊 BACKFILL COMPLETE`);
    console.log(`========================================`);
    console.log(`✅ Fixed:   ${fixed}`);
    console.log(`⏭️  Skipped: ${skipped}`);
    console.log(`📦 Total:   ${broken.length}`);

    // Verify
    const stillBroken = await attributions.countDocuments({
      $or: [{ registrationId: { $exists: false } }, { registrationId: null }],
    });
    console.log(`\n🔍 Remaining unlinked: ${stillBroken}`);
  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Database connection closed.');
  }
}

backfillAttributions();
