// utils/seasonStatus.js
// Single source of truth for player/parent status based on active SeasonEvents.
// Mirrors the frontend `statusUtils.ts` logic.

const SeasonEvent = require('../models/SeasonEvent');

/**
 * Does a player's season name match a SeasonEvent's season?
 * "Spring Tryout 2026"  matches SeasonEvent { season: "Spring", year: 2026 }
 * "Bothell Select Tryouts 2026" matches itself exactly.
 */
function seasonMatchesEvent(playerSeason, event) {
  if (!playerSeason || !event || !event.season) return false;
  const ps = String(playerSeason).toLowerCase().trim();
  const es = String(event.season).toLowerCase().trim();
  if (!ps || !es) return false;
  if (ps === es) return true;
  if (ps.includes(es)) return true;
  if (es.includes(ps)) return true;
  return false;
}

/**
 * Find the player's registration entry for a given SeasonEvent.
 * 1. tryoutId === eventId   (strongest match)
 * 2. season name + year
 * 3. legacy top-level season/registrationYear
 */
function getPlayerRegForEvent(player, event) {
  if (!player || !event) return null;

  const seasons = Array.isArray(player.seasons) ? player.seasons : [];

  // 1. Exact tryoutId match
  if (event.eventId) {
    const byEventId = seasons.find(
      (s) => s.tryoutId && String(s.tryoutId) === String(event.eventId),
    );
    if (byEventId) return byEventId;
  }

  // 2. Season name + year match
  const byName = seasons.find(
    (s) =>
      seasonMatchesEvent(s.season, event) &&
      Number(s.year) === Number(event.year),
  );
  if (byName) return byName;

  // 3. Legacy top-level fallback
  if (
    player.season &&
    seasonMatchesEvent(player.season, event) &&
    Number(player.registrationYear) === Number(event.year)
  ) {
    return {
      season: player.season,
      year: player.registrationYear,
      paymentComplete: player.paymentComplete,
      paymentStatus: player.paymentStatus,
    };
  }

  return null;
}

/**
 * Active          = paid registration for ANY active SeasonEvent
 * Pending Payment = unpaid registration for ANY active SeasonEvent (no paid ones)
 * Inactive        = no registration for ANY active SeasonEvent
 */
function getPlayerStatus(player, activeEvents) {
  if (!activeEvents || activeEvents.length === 0) return 'Inactive';

  let hasAny = false;
  let hasPaid = false;

  for (const event of activeEvents) {
    const reg = getPlayerRegForEvent(player, event);
    if (reg) {
      hasAny = true;
      if (reg.paymentComplete === true || reg.paymentStatus === 'paid') {
        hasPaid = true;
      }
    }
  }

  if (!hasAny) return 'Inactive';
  if (hasPaid) return 'Active';
  return 'Pending Payment';
}

/**
 * Parent status = best status among their players.
 * Coaches are always Active.
 */
function getParentStatus(parent, activeEvents) {
  if (!parent) return 'Inactive';
  if (parent.isCoach) return 'Active';

  const players = parent.players || [];
  if (players.length === 0) return 'Inactive';

  let hasActive = false;
  let hasPending = false;

  for (const p of players) {
    const s = getPlayerStatus(p, activeEvents);
    if (s === 'Active') hasActive = true;
    if (s === 'Pending Payment') hasPending = true;
  }

  if (hasActive) return 'Active';
  if (hasPending) return 'Pending Payment';
  return 'Inactive';
}

async function getActiveSeasonEvents() {
  const now = new Date();
  return SeasonEvent.find({
    isActiveOverride: { $ne: 'always-off' },
    isActive: { $ne: false },
    $or: [
      { startDate: { $exists: false } },
      { startDate: null },
      { startDate: { $lte: now } },
    ],
    $and: [
      {
        $or: [
          { endDate: { $exists: false } },
          { endDate: null },
          { endDate: { $gte: now } },
        ],
      },
    ],
  }).lean();
}

module.exports = {
  seasonMatchesEvent,
  getPlayerRegForEvent,
  getPlayerStatus,
  getParentStatus,
  getActiveSeasonEvents,
};
