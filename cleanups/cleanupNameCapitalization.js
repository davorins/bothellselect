// cleanupNameCapitalization.js
require('dotenv').config();
const mongoose = require('mongoose');

const uri =
  'mongodb+srv://bothellselect:nrMNUpNv7Zavgfak@bothellselect.9wh96.mongodb.net/bothellselect?retryWrites=true&w=majority&appName=bothellselect';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SUFFIXES = new Set([
  'Jr.',
  'Sr.',
  'II',
  'III',
  'IV',
  'V',
  'Esq.',
  'PhD',
  'MD',
  'DDS',
]);

/**
 * Capitalizes first letter, lowercases the rest.
 * Handles hyphenated names: "mary-jane" → "Mary-Jane"
 */
const capitalizeName = (name) => {
  if (!name || !name.trim()) return name;
  return name
    .trim()
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('-');
};

/**
 * Normalizes a middle name / middle name word:
 *
 *  Single letter    "j"      → "J."
 *  Two letters      "jo"     → "Jo"   (short full name, not initial)
 *  With dots        "a.b."   → "A.B." (compact initials)
 *  No dots 2 chars  "ab"     → "A.B." — NOT applied; 2 chars → "Ab" (short full name)
 *  3+ letters       "andrew" → "Andrew"
 *  Multiple words   "anne charlotte" → each word processed independently
 */
const normalizeMiddleName = (middle) => {
  if (!middle || !middle.trim()) return middle;

  // Multiple words — process each independently
  if (middle.trim().includes(' ')) {
    return middle.trim().split(/\s+/).map(normalizeMiddleName).join(' ');
  }

  const stripped = middle.trim().replace(/\./g, '');
  if (!stripped) return middle.trim();

  const looksLikeInitials = middle.includes('.');

  if (looksLikeInitials) {
    // "a.b" / "A.B." → "A.B."
    return stripped
      .split('')
      .map((ch) => ch.toUpperCase() + '.')
      .join('');
  }

  const len = stripped.length;

  if (len === 1) {
    // "j" → "J."
    return stripped.toUpperCase() + '.';
  }

  if (len === 2) {
    // "jo" → "Jo"  (short name, not initials)
    return capitalizeName(stripped);
  }

  // 3+ letters → full name
  return capitalizeName(stripped);
};

/**
 * Normalizes a full name string word by word.
 * Middle words (not first, not last, not suffix) get middle-name treatment.
 * e.g. "JOHN a doe Jr." → "John A. Doe Jr."
 * e.g. "john a.b smith" → "John A.B. Smith"
 */
const normalizeFullName = (fullName) => {
  if (!fullName || !fullName.trim()) return fullName;

  const words = fullName.trim().split(/\s+/);

  if (words.length <= 2) {
    // Just first + last (or just first): normal capitalize, no middle treatment
    return words
      .map((w) => (SUFFIXES.has(w) ? w : capitalizeName(w)))
      .join(' ');
  }

  return words
    .map((word, i) => {
      if (SUFFIXES.has(word)) return word;
      const isFirst = i === 0;
      const isLast = i === words.length - 1 && !SUFFIXES.has(words[i]);
      // Detect if last word is actually a suffix, making second-to-last the real last
      const effectiveLast = SUFFIXES.has(words[words.length - 1])
        ? i === words.length - 2
        : i === words.length - 1;

      if (isFirst || effectiveLast) return capitalizeName(word);
      return normalizeMiddleName(word); // middle words
    })
    .join(' ');
};

const needsNormalization = (fullName) => {
  if (!fullName || !fullName.trim()) return false;
  return normalizeFullName(fullName) !== fullName;
};

// ─── Main ─────────────────────────────────────────────────────────────────────

async function cleanupNameCapitalization() {
  try {
    await mongoose.connect(uri, {});
    const db = mongoose.connection.db;

    console.log('🚀 Starting name capitalization cleanup...\n');

    // ============================================
    // PART 1: Normalize Parent fullNames
    // ============================================
    console.log('🧹 PART 1: Normalizing parent names...');
    const parents = db.collection('parents');

    const allParents = await parents
      .find({ fullName: { $exists: true, $ne: null } })
      .toArray();

    let parentsUpdated = 0;

    for (const parent of allParents) {
      const updates = {};

      if (needsNormalization(parent.fullName)) {
        updates.fullName = normalizeFullName(parent.fullName);
      }

      if (Object.keys(updates).length > 0) {
        await parents.updateOne({ _id: parent._id }, { $set: updates });
        parentsUpdated++;
        console.log(
          `   ✅ Parent: "${parent.fullName}" → "${updates.fullName}"`,
        );
      }
    }

    console.log(
      `\n📊 PARENTS SUMMARY: Updated ${parentsUpdated} parent names\n`,
    );

    // ============================================
    // PART 2: Normalize Guardian fullNames
    // (guardians are embedded in the parents collection)
    // ============================================
    console.log('🧹 PART 2: Normalizing guardian names...');

    const parentsWithGuardians = await parents
      .find({
        'additionalGuardians.0': { $exists: true },
      })
      .toArray();

    let guardiansUpdated = 0;
    let parentsWithGuardiansUpdated = 0;

    for (const parent of parentsWithGuardians) {
      let modified = false;
      const updatedGuardians = parent.additionalGuardians.map((guardian) => {
        const updates = { ...guardian };
        let changed = false;

        if (needsNormalization(guardian.fullName)) {
          console.log(
            `   ✅ Guardian: "${guardian.fullName}" → "${normalizeFullName(guardian.fullName)}" (parent: ${parent.fullName})`,
          );
          updates.fullName = normalizeFullName(guardian.fullName);
          changed = true;
        }

        if (changed) {
          guardiansUpdated++;
          modified = true;
        }

        return updates;
      });

      if (modified) {
        await parents.updateOne(
          { _id: parent._id },
          { $set: { additionalGuardians: updatedGuardians } },
        );
        parentsWithGuardiansUpdated++;
      }
    }

    console.log(`\n📊 GUARDIANS SUMMARY:`);
    console.log(`   - Updated ${guardiansUpdated} guardian names`);
    console.log(
      `   - Across ${parentsWithGuardiansUpdated} parent documents\n`,
    );

    // ============================================
    // PART 3: Normalize Player fullNames
    // ============================================
    console.log('🧹 PART 3: Normalizing player names...');
    const players = db.collection('players');

    const allPlayers = await players
      .find({ fullName: { $exists: true, $ne: null } })
      .toArray();

    let playersUpdated = 0;

    for (const player of allPlayers) {
      const updates = {};

      if (needsNormalization(player.fullName)) {
        updates.fullName = normalizeFullName(player.fullName);
      }

      if (Object.keys(updates).length > 0) {
        await players.updateOne({ _id: player._id }, { $set: updates });
        playersUpdated++;
        console.log(
          `   ✅ Player: "${player.fullName}" → "${updates.fullName}"`,
        );
      }
    }

    console.log(
      `\n📊 PLAYERS SUMMARY: Updated ${playersUpdated} player names\n`,
    );

    // ============================================
    // FINAL SUMMARY
    // ============================================
    console.log('========================================');
    console.log('✅ NAME CAPITALIZATION CLEANUP COMPLETE');
    console.log('========================================');
    console.log(`📊 Parents:   ${parentsUpdated} names normalized`);
    console.log(`📊 Guardians: ${guardiansUpdated} names normalized`);
    console.log(`📊 Players:   ${playersUpdated} names normalized`);
    console.log(
      `📊 Total:     ${parentsUpdated + guardiansUpdated + playersUpdated} names normalized`,
    );

    // ─── Dry-run check: show any remaining non-normalized names ───────────────
    console.log(
      '\n🔍 Verifying — checking for any remaining non-normalized names...',
    );

    const remainingParents = await parents
      .find({ fullName: { $exists: true, $ne: null } })
      .toArray();
    const badParents = remainingParents.filter((p) =>
      needsNormalization(p.fullName),
    );

    const remainingPlayers = await players
      .find({ fullName: { $exists: true, $ne: null } })
      .toArray();
    const badPlayers = remainingPlayers.filter((p) =>
      needsNormalization(p.fullName),
    );

    const remainingGuardianParents = await parents
      .find({ 'additionalGuardians.0': { $exists: true } })
      .toArray();
    const badGuardians = remainingGuardianParents.flatMap((p) =>
      (p.additionalGuardians || []).filter((g) =>
        needsNormalization(g.fullName),
      ),
    );

    if (badParents.length + badPlayers.length + badGuardians.length === 0) {
      console.log('✅ All names are correctly normalized.');
    } else {
      console.log(`⚠️  Still found non-normalized names:`);
      badParents.forEach((p) => console.log(`   Parent: "${p.fullName}"`));
      badGuardians.forEach((g) => console.log(`   Guardian: "${g.fullName}"`));
      badPlayers.forEach((p) => console.log(`   Player: "${p.fullName}"`));
    }
  } catch (err) {
    console.error('❌ Error during name cleanup:', err);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Database connection closed.');
  }
}

// Run the cleanup
cleanupNameCapitalization();
