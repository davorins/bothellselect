// cleanupAllDuplicates.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri =
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

async function cleanupAllDuplicates() {
  try {
    await mongoose.connect(uri, {});
    const db = mongoose.connection.db;

    console.log('🚀 Starting comprehensive duplicate cleanup...\n');

    // ============================================
    // PART 1: Clean up duplicate REGISTRATIONS
    // ============================================
    console.log('🧹 PART 1: Cleaning duplicate registrations...');
    const registrations = db.collection('registrations');

    // Find duplicate registrations
    const registrationDuplicates = await registrations
      .aggregate([
        {
          $match: {
            player: { $exists: true, $ne: null },
            season: { $exists: true, $ne: null },
            year: { $exists: true, $ne: null },
          },
        },
        {
          $group: {
            _id: {
              player: '$player',
              season: '$season',
              year: '$year',
              tryoutId: '$tryoutId',
            },
            docs: { $push: '$$ROOT' },
            count: { $sum: 1 },
          },
        },
        {
          $match: {
            count: { $gt: 1 },
          },
        },
      ])
      .toArray();

    let registrationsDeleted = 0;

    for (const group of registrationDuplicates) {
      const { player, season, year, tryoutId } = group._id;
      const docs = group.docs;

      // Priority: Keep PAID registrations first
      let keepDoc = docs.find(
        (d) => d.paymentStatus === 'paid' || d.paymentComplete === true,
      );

      // If no paid, keep most recent
      if (!keepDoc) {
        keepDoc = docs.reduce((latest, current) =>
          new Date(current.createdAt) > new Date(latest.createdAt)
            ? current
            : latest,
        );
      }

      // Delete the rest
      const deleteIds = docs
        .filter((d) => d._id.toString() !== keepDoc._id.toString())
        .map((d) => d._id);

      if (deleteIds.length > 0) {
        await registrations.deleteMany({ _id: { $in: deleteIds } });
        registrationsDeleted += deleteIds.length;
        console.log(
          `   ✅ Player ${player}: Deleted ${deleteIds.length} duplicate registration(s) for ${season} ${year}`,
        );
      }
    }

    console.log(
      `\n📊 REGISTRATIONS SUMMARY: Deleted ${registrationsDeleted} duplicate registrations\n`,
    );

    // ============================================
    // PART 2: Clean up duplicate SEASONS in Players
    // ============================================
    console.log(
      '🧹 PART 2: Cleaning duplicate seasons in players collection...',
    );
    const players = db.collection('players');

    // Find all players with seasons
    const allPlayers = await players
      .find({
        seasons: { $exists: true, $ne: [] },
      })
      .toArray();

    let playersUpdated = 0;
    let seasonsRemoved = 0;

    for (const player of allPlayers) {
      if (!player.seasons || player.seasons.length === 0) continue;

      const originalCount = player.seasons.length;
      const seen = new Map();
      const uniqueSeasons = [];

      // Process each season, keeping only unique ones
      for (const season of player.seasons) {
        const key = `${season.season}|${season.year}|${season.tryoutId || 'null'}`;

        if (!seen.has(key)) {
          seen.set(key, true);
          uniqueSeasons.push(season);
        } else {
          seasonsRemoved++;
        }
      }

      // If duplicates were found, update the player
      if (uniqueSeasons.length !== originalCount) {
        // Sort seasons by year (desc), then by registration date (desc)
        uniqueSeasons.sort((a, b) => {
          if (b.year !== a.year) return b.year - a.year;
          return (
            new Date(b.registrationDate || 0) -
            new Date(a.registrationDate || 0)
          );
        });

        await players.updateOne(
          { _id: player._id },
          { $set: { seasons: uniqueSeasons } },
        );

        playersUpdated++;
        console.log(
          `   ✅ Player ${player.fullName}: Removed ${originalCount - uniqueSeasons.length} duplicate seasons`,
        );
      }
    }

    console.log(`\n📊 PLAYERS SUMMARY:`);
    console.log(`   - Updated ${playersUpdated} players`);
    console.log(`   - Removed ${seasonsRemoved} duplicate seasons`);

    // ============================================
    // PART 3: Sync player top-level fields
    // ============================================
    console.log('\n🧹 PART 3: Syncing player top-level fields...');

    const playersToSync = await players
      .find({
        seasons: { $exists: true, $ne: [] },
      })
      .toArray();

    let playersSynced = 0;

    for (const player of playersToSync) {
      if (player.seasons && player.seasons.length > 0) {
        // Find the latest season (based on year and registration date)
        const sortedSeasons = [...player.seasons].sort((a, b) => {
          if (b.year !== a.year) return b.year - a.year;
          return (
            new Date(b.registrationDate || 0) -
            new Date(a.registrationDate || 0)
          );
        });

        const latestSeason = sortedSeasons[0];
        const hasPaidSeason = sortedSeasons.some(
          (s) => s.paymentStatus === 'paid',
        );

        const updateFields = {
          registrationYear: latestSeason.year,
          season: latestSeason.season,
          paymentComplete: hasPaidSeason,
          paymentStatus: hasPaidSeason
            ? 'paid'
            : player.paymentStatus || 'pending',
        };

        // Update lastPaymentDate if there are paid seasons
        const paidSeasons = sortedSeasons.filter(
          (s) => s.paymentStatus === 'paid' && s.paymentDate,
        );
        if (paidSeasons.length > 0) {
          const latestPayment = paidSeasons.sort(
            (a, b) => new Date(b.paymentDate) - new Date(a.paymentDate),
          )[0];
          updateFields.lastPaymentDate = latestPayment.paymentDate;
        }

        // Check if update is needed
        const needsUpdate = Object.keys(updateFields).some(
          (key) =>
            JSON.stringify(player[key]) !== JSON.stringify(updateFields[key]),
        );

        if (needsUpdate) {
          await players.updateOne({ _id: player._id }, { $set: updateFields });
          playersSynced++;
        }
      }
    }

    console.log(
      `📊 SYNC SUMMARY: Synced ${playersSynced} players' top-level fields`,
    );

    // ============================================
    // FINAL SUMMARY
    // ============================================
    console.log('\n========================================');
    console.log('✅ COMPREHENSIVE CLEANUP COMPLETE');
    console.log('========================================');
    console.log(`📊 Registrations: Deleted ${registrationsDeleted} duplicates`);
    console.log(`📊 Players: Updated ${playersUpdated} players`);
    console.log(`📊 Seasons: Removed ${seasonsRemoved} duplicate seasons`);
    console.log(`📊 Sync: Updated ${playersSynced} player fields`);

    // Show remaining duplicate counts
    const remainingRegDuplicates = await registrations
      .aggregate([
        {
          $group: {
            _id: {
              player: '$player',
              season: '$season',
              year: '$year',
              tryoutId: '$tryoutId',
            },
            count: { $sum: 1 },
          },
        },
        { $match: { count: { $gt: 1 } } },
        { $count: 'total' },
      ])
      .toArray();

    console.log(
      `\n🔍 REMAINING DUPLICATE REGISTRATIONS: ${remainingRegDuplicates[0]?.total || 0}`,
    );
  } catch (err) {
    console.error('❌ Error during cleanup:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the cleanup
cleanupAllDuplicates();
