// backend/scripts/migrate-tournament-dates.js
//
// One-time migration: convert legacy ISODate calendar-day fields
// on TournamentConfig and TryoutConfig documents into "YYYY-MM-DD" strings.
//
// Run:   node backend/scripts/migrate-tournament-dates.js
// Safe:  idempotent — "YYYY-MM-DD" strings pass through unchanged.
//
// NOTE: reads/writes use the raw driver collection (Model.collection) so
// Mongoose schema casting can't turn Dates into strings (or strings back
// into Dates) mid-migration. Run this BEFORE deploying the String schemas.

require('dotenv').config();
const mongoose = require('mongoose');
const TournamentConfig = require('../models/TournamentConfig');
const TryoutConfig = require('../models/TryoutConfig');
const uri =
  process.env.MONGO_URI ||
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';
if (!uri) {
  console.error('❌ MONGO_URI is not set in the environment.');
  process.exit(1);
}

// ─── Helpers ────────────────────────────────────────────────────────
const toYMD = (d) => {
  if (!d) return '';
  if (typeof d === 'string') {
    // already YMD
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    // ISO string
    if (/^\d{4}-\d{2}-\d{2}T/.test(d)) return d.split('T')[0];
    // MM/DD/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(d)) {
      const [m, day, y] = d.split('/');
      return `${y}-${m}-${day}`;
    }
    return '';
  }
  if (!(d instanceof Date) || isNaN(d.getTime())) return '';
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const isYMD = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const needsMigration = (v) => {
  if (!v) return false;
  if (v instanceof Date) return true;
  return !isYMD(v);
};

// ─── Migrate Tournaments ────────────────────────────────────────────
async function migrateTournaments() {
  console.log('\n🏆 Migrating TournamentConfigs...\n');

  const col = TournamentConfig.collection;
  const docs = await col.find({}).toArray();
  let fixed = 0;
  let skipped = 0;

  for (const doc of docs) {
    const patch = {};

    if (needsMigration(doc.registrationDeadline)) {
      patch.registrationDeadline = toYMD(doc.registrationDeadline);
    }
    if (needsMigration(doc.paymentDeadline)) {
      patch.paymentDeadline = toYMD(doc.paymentDeadline);
    }
    if (
      Array.isArray(doc.tournamentDates) &&
      doc.tournamentDates.some(needsMigration)
    ) {
      patch.tournamentDates = doc.tournamentDates.map(toYMD).filter(Boolean);
    }

    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }

    await col.updateOne({ _id: doc._id }, { $set: patch });
    fixed++;
    console.log(
      `✅ Tournament "${doc.tournamentName}" →`,
      JSON.stringify(patch),
    );
  }

  console.log(
    `\n🏆 Tournaments — fixed: ${fixed}, skipped: ${skipped}, total: ${docs.length}`,
  );
  return { fixed, skipped, total: docs.length };
}

// ─── Migrate Tryouts ────────────────────────────────────────────────
async function migrateTryouts() {
  console.log('\n🎯 Migrating TryoutConfigs...\n');

  const col = TryoutConfig.collection;
  const docs = await col.find({}).toArray();
  let fixed = 0;
  let skipped = 0;

  for (const doc of docs) {
    const patch = {};

    if (needsMigration(doc.registrationDeadline)) {
      patch.registrationDeadline = toYMD(doc.registrationDeadline);
    }
    if (needsMigration(doc.paymentDeadline)) {
      patch.paymentDeadline = toYMD(doc.paymentDeadline);
    }
    if (
      Array.isArray(doc.tryoutDates) &&
      doc.tryoutDates.some(needsMigration)
    ) {
      patch.tryoutDates = doc.tryoutDates.map(toYMD).filter(Boolean);
    }

    // Nested tryoutDetails.tryoutSessions[].date
    const sessions = doc.tryoutDetails?.tryoutSessions;
    if (
      Array.isArray(sessions) &&
      sessions.some((s) => needsMigration(s?.date))
    ) {
      patch['tryoutDetails.tryoutSessions'] = sessions.map((s) => ({
        ...s,
        date: toYMD(s?.date),
      }));
    }

    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }

    await col.updateOne({ _id: doc._id }, { $set: patch });
    fixed++;
    console.log(
      `✅ Tryout "${doc.tryoutName}" →`,
      Object.keys(patch).join(', '),
    );
  }

  console.log(
    `\n🎯 Tryouts — fixed: ${fixed}, skipped: ${skipped}, total: ${docs.length}`,
  );
  return { fixed, skipped, total: docs.length };
}

// ─── Verify ─────────────────────────────────────────────────────────
async function verify() {
  const stillDateTournaments = await TournamentConfig.collection.countDocuments(
    {
      $or: [
        { registrationDeadline: { $type: 'date' } },
        { paymentDeadline: { $type: 'date' } },
        { tournamentDates: { $elemMatch: { $type: 'date' } } },
      ],
    },
  );

  const stillDateTryouts = await TryoutConfig.collection.countDocuments({
    $or: [
      { registrationDeadline: { $type: 'date' } },
      { paymentDeadline: { $type: 'date' } },
      { tryoutDates: { $elemMatch: { $type: 'date' } } },
      { 'tryoutDetails.tryoutSessions.date': { $type: 'date' } },
    ],
  });

  console.log('\n🔍 Verification (remaining Date-typed fields):');
  console.log(`   Tournaments: ${stillDateTournaments}`);
  console.log(`   Tryouts:     ${stillDateTryouts}`);

  if (stillDateTournaments === 0 && stillDateTryouts === 0) {
    console.log('\n✅ All calendar-day fields are now "YYYY-MM-DD" strings.');
  } else {
    console.log('\n⚠️  Some documents still hold Date objects — review above.');
  }
}

// ─── Main ───────────────────────────────────────────────────────────
(async () => {
  try {
    await mongoose.connect(uri);
    console.log('🔌 Connected to MongoDB');

    const t = await migrateTournaments();
    const y = await migrateTryouts();

    console.log('\n========================================');
    console.log('📊 MIGRATION COMPLETE');
    console.log('========================================');
    console.log(`🏆 Tournaments: ${t.fixed} fixed / ${t.total} total`);
    console.log(`🎯 Tryouts:     ${y.fixed} fixed / ${y.total} total`);

    await verify();
  } catch (err) {
    console.error('❌ Migration error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Database connection closed.');
  }
})();
