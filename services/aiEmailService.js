require('dotenv').config();

const OpenAI = require('openai');
const { Resend } = require('resend');

const AiEmail = require('../models/AiEmail');
const AiSettings = require('../models/AiSettings');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const PlayerRegistration = require('../models/PlayerRegistration');
const Payment = require('../models/Payment');
const Team = require('../models/Team');
const EventConfig = require('../models/EventConfig');
const TryoutConfig = require('../models/TryoutConfig');
const FAQ = require('../models/Faq');

// ─────────────────────────────────────────────────────────────────────────────
// Clients + config
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.OPENAI_API_KEY) {
  console.warn('[aiEmailService] OPENAI_API_KEY is not set.');
}
if (!process.env.RESEND_API_KEY) {
  console.warn('[aiEmailService] RESEND_API_KEY is not set.');
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = new Resend(process.env.RESEND_API_KEY);

const VERIFIED_SENDER =
  process.env.VERIFIED_SENDER || 'Bothell Select <info@bothellselect.com>';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const CURRENT_TRYOUT_YEAR = Number(process.env.CURRENT_TRYOUT_YEAR) || null;
const CURRENT_TRYOUT_ID = process.env.CURRENT_TRYOUT_ID || null;
const CURRENT_TRYOUT_LABEL =
  process.env.CURRENT_TRYOUT_LABEL || 'Bothell Select Tryouts';

// Addresses that belong to the site itself, never to a parent. Contact-form
// submissions always arrive "from" one of these. Even if one of them happens
// to also exist as a Parent record (e.g. an admin account), it must never be
// treated as the matched parent for an inbound email.
const SITE_OWNED_EMAILS = new Set(
  [
    'info@bothellselect.com',
    'bothellselect@proton.me',
    process.env.VERIFIED_SENDER_EMAIL,
  ]
    .filter(Boolean)
    .map((e) => e.toLowerCase()),
);

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

async function getAiSettings() {
  let settings = await AiSettings.findOne({ key: 'default' });
  if (!settings) {
    settings = await AiSettings.create({ key: 'default' });
  }
  return settings;
}

async function updateAiSettings(updates, updatedBy = null) {
  const settings = await getAiSettings();
  const allowed = [
    'enabled',
    'automaticRepliesEnabled',
    'confidenceThreshold',
    'tone',
    'allowedAutomaticCategories',
    'alwaysRequireHumanReview',
  ];
  for (const key of allowed) {
    if (key in updates) settings[key] = updates[key];
  }
  if (updatedBy) settings.updatedBy = updatedBy;
  await settings.save();
  return settings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Email address normalization
// ─────────────────────────────────────────────────────────────────────────────

function extractEmailAddress(rawFrom) {
  if (!rawFrom) return '';
  const match = String(rawFrom).match(/<([^>]+)>/);
  const address = match ? match[1] : rawFrom;
  return address.toLowerCase().trim();
}

function extractEmailFromBody(body) {
  if (!body) return '';
  const labeledMatch = String(body).match(
    /email\s*:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
  );
  if (labeledMatch) return labeledMatch[1].toLowerCase().trim();
  const anyMatch = String(body).match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  );
  return anyMatch ? anyMatch[0].toLowerCase().trim() : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Parent / player / registration / payment / team lookups
// ─────────────────────────────────────────────────────────────────────────────

async function findParent(email) {
  if (!email) return null;
  return Parent.findOne({ email: extractEmailAddress(email) }).select(
    '-password',
  );
}

async function findParentById(parentId) {
  if (!parentId) return null;
  return Parent.findById(parentId).select('-password');
}

// Look up the parent's players via BOTH the parent.players array AND the
// player.parentId back-reference. This guarantees a player is never invisible
// to the AI if one side of the relationship is stale.
async function findPlayersByParent(parentId) {
  if (!parentId) return [];

  const parent = await Parent.findById(parentId).select('players');
  const playerIdsFromParentArray = (parent?.players || []).map((id) =>
    id.toString(),
  );

  return Player.find({
    $or: [{ parentId }, { _id: { $in: playerIdsFromParentArray } }],
  });
}

async function findPlayer(playerId) {
  if (!playerId) return null;
  return Player.findById(playerId);
}

async function findRegistrationsByPlayer(playerId) {
  if (!playerId) return [];
  return PlayerRegistration.find({ playerId }).sort({ createdAt: -1 });
}

async function findRegistrationsByParent(parentId) {
  if (!parentId) return [];

  const players = await Player.find({ parentId }).select('_id');
  const playerIds = players.map((p) => p._id);
  if (playerIds.length === 0) return [];

  return PlayerRegistration.find({
    playerId: { $in: playerIds },
  }).sort({ createdAt: -1 });
}

async function findPaymentsByParent(parentId) {
  if (!parentId) return [];
  return Payment.find({ parentId }).sort({ createdAt: -1 });
}

async function findPaymentsByPlayer(playerId) {
  if (!playerId) return [];
  return Payment.find({
    $or: [
      { playerId },
      { playerIds: playerId },
      { 'players.playerId': playerId },
    ],
  }).sort({ createdAt: -1 });
}

async function findPaymentsByTeam(teamId) {
  if (!teamId) return [];
  return Payment.find({
    $or: [{ teamId }, { teamIds: teamId }],
  }).sort({ createdAt: -1 });
}

async function findTeam(teamId) {
  if (!teamId) return null;
  return Team.findById(teamId);
}

async function findTeamsByCoach(coachId) {
  if (!coachId) return [];
  return Team.find({ coachIds: coachId, isActive: true }).sort({
    registrationYear: -1,
    name: 1,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// AiEmail CRUD
// ─────────────────────────────────────────────────────────────────────────────

async function createAiEmail(emailData) {
  if (!emailData || !emailData.messageId) {
    throw new Error('messageId is required to create an AI email');
  }
  if (!emailData.from) {
    throw new Error('from is required to create an AI email');
  }
  if (!emailData.body) {
    throw new Error('body is required to create an AI email');
  }

  return AiEmail.create({
    messageId: emailData.messageId,
    threadId: emailData.threadId || null,
    from: emailData.from,
    to: emailData.to || null,
    subject: emailData.subject || '',
    body: emailData.body,
    receivedAt: emailData.receivedAt || new Date(),
    status: 'new',
    requiresHumanReview: true,
  });
}

async function getPendingAiEmails({ page = 1, limit = 25 } = {}) {
  const filter = { status: { $in: ['new', 'draft_ready', 'reviewed'] } };
  const skip = (Math.max(1, page) - 1) * limit;

  const [emails, total] = await Promise.all([
    AiEmail.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit),
    AiEmail.countDocuments(filter),
  ]);

  return { emails, total, page: Math.max(1, page), limit };
}

async function getAllAiEmails({ page = 1, limit = 25, status = null } = {}) {
  const filter = {};
  if (status) filter.status = status;
  const skip = (Math.max(1, page) - 1) * limit;

  const [emails, total] = await Promise.all([
    AiEmail.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit),
    AiEmail.countDocuments(filter),
  ]);

  return { emails, total, page: Math.max(1, page), limit };
}

async function getAiEmailById(id) {
  if (!id) return null;
  return AiEmail.findById(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context building
// ─────────────────────────────────────────────────────────────────────────────

function sortSeasonsDesc(seasons) {
  return [...(seasons || [])].sort((a, b) => {
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;
    if (by !== ay) return by - ay;
    const ad = a.registrationDate ? new Date(a.registrationDate).getTime() : 0;
    const bd = b.registrationDate ? new Date(b.registrationDate).getTime() : 0;
    return bd - ad;
  });
}

async function buildParentContext(parent) {
  if (!parent) {
    return {
      parentFound: false,
      parent: null,
      players: [],
      registrations: [],
      payments: [],
    };
  }

  const players = await findPlayersByParent(parent._id);

  const registrationsFromSeasons = players.flatMap((player) =>
    sortSeasonsDesc(player.seasons).map((season) => ({
      playerId: player._id.toString(),
      playerName: player.fullName || '',
      season: season.season || '',
      year: season.year || null,
      tryoutId: season.tryoutId || null,
      registrationDate: season.registrationDate || null,
      registrationComplete: player.registrationComplete || false,
      paymentComplete: season.paymentComplete || false,
      paymentStatus: season.paymentStatus || 'unknown',
      paymentId: season.paymentId || null,
      amountPaid: season.amountPaid ?? null,
      paymentDate: season.paymentDate || null,
      cardLast4: season.cardLast4 || null,
      cardBrand: season.cardBrand || null,
    })),
  );

  const standaloneRegistrations = await findRegistrationsByParent(parent._id);

  const normalizedStandalone = standaloneRegistrations.map((reg) => ({
    playerId: reg.playerId ? reg.playerId.toString() : null,
    playerName: '',
    season: reg.season || '',
    year: reg.year || null,
    tryoutId: reg.tryoutId || null,
    registrationDate: reg.createdAt || null,
    registrationComplete: reg.status === 'complete',
    paymentComplete: reg.paymentComplete || false,
    paymentStatus: reg.paymentStatus || 'unknown',
    paymentId: reg.paymentId || null,
    amountPaid: reg.amountPaid ?? null,
    paymentDate: reg.paymentDate || null,
    cardLast4: null,
    cardBrand: null,
  }));

  const allRegistrations = [
    ...registrationsFromSeasons,
    ...normalizedStandalone,
  ];

  const allPayments = allRegistrations
    .filter((r) => r.paymentId || r.amountPaid)
    .map((r) => ({
      playerId: r.playerId,
      playerName: r.playerName,
      season: r.season,
      paymentId: r.paymentId,
      amountPaid: r.amountPaid,
      status: r.paymentStatus,
      paidAt: r.paymentDate,
      cardLast4: r.cardLast4,
      cardBrand: r.cardBrand,
    }));

  return {
    parentFound: true,
    parent: {
      id: parent._id.toString(),
      fullName: parent.fullName || '',
      email: parent.email || '',
      phone: parent.phone || '',
      relationship: parent.relationship || '',
      role: parent.role || '',
    },
    players: players.map((player) => ({
      id: player._id.toString(),
      fullName: player.fullName || '',
      gender: player.gender || '',
      grade: player.grade || '',
      aauNumber: player.aauNumber || '',
      registrationYear: player.registrationYear || null,
      registrationComplete: player.registrationComplete || false,
      paymentComplete: player.paymentComplete || false,
      paymentStatus: player.paymentStatus || '',
      lastPaymentDate: player.lastPaymentDate || null,
      healthConcerns: player.healthConcerns || '',
      seasons: sortSeasonsDesc(player.seasons).map((s) => ({
        season: s.season || '',
        year: s.year || null,
        tryoutId: s.tryoutId || null,
        registrationDate: s.registrationDate || null,
        paymentComplete: s.paymentComplete || false,
        paymentStatus: s.paymentStatus || 'unknown',
        paymentId: s.paymentId || null,
        amountPaid: s.amountPaid ?? null,
        paymentDate: s.paymentDate || null,
        cardLast4: s.cardLast4 || null,
        cardBrand: s.cardBrand || null,
      })),
    })),
    registrations: allRegistrations,
    payments: allPayments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// AI tool functions — called by the model via function-calling
// ─────────────────────────────────────────────────────────────────────────────

async function getParentByEmail(email) {
  const parent = await findParent(email);
  if (!parent) return null;
  return {
    id: parent._id.toString(),
    fullName: parent.fullName || '',
    email: parent.email || '',
    phone: parent.phone || '',
    role: parent.role || '',
  };
}

async function getFamilyData(parentId) {
  const parent = await findParentById(parentId);
  return buildParentContext(parent);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tryout lookup — TryoutConfig first, EventConfig fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Authoritative schedule/location/logistics data for the current tryout.
 *
 * SOURCE PRIORITY:
 *   1. TryoutConfig (collection: tryoutconfigs) — has detailed per-session
 *      schedules, drop-off instructions, what-to-bring, etc. PREFERRED.
 *   2. EventConfig  (collection: eventconfigs) — general event fallback.
 *
 * Never invent tryout details. Never substitute registration/payment
 * status as an answer to a logistics question.
 */
async function getCurrentTryoutInfo() {
  // ─────────────────────────────────────────────────────────────────
  // 1. TryoutConfig — try configured ID first, then year, then newest
  // ─────────────────────────────────────────────────────────────────
  let tryoutConfig = null;

  if (CURRENT_TRYOUT_ID) {
    tryoutConfig = await TryoutConfig.findOne({
      isActive: true,
      $or: [{ eventId: CURRENT_TRYOUT_ID }, { season: CURRENT_TRYOUT_ID }],
    }).lean();
  }

  if (!tryoutConfig && CURRENT_TRYOUT_YEAR) {
    tryoutConfig = await TryoutConfig.findOne({
      isActive: true,
      tryoutYear: CURRENT_TRYOUT_YEAR,
    })
      .sort({ updatedAt: -1, createdAt: -1 })
      .lean();
  }

  if (!tryoutConfig) {
    tryoutConfig = await TryoutConfig.findOne({ isActive: true })
      .sort({ tryoutYear: -1, updatedAt: -1, createdAt: -1 })
      .lean();
  }

  console.log(
    '[aiEmailService] TryoutConfig lookup:',
    tryoutConfig
      ? `found "${tryoutConfig.tryoutName}" (year ${tryoutConfig.tryoutYear})`
      : 'none',
  );

  // ─────────────────────────────────────────────────────────────────
  // 2. EventConfig — general-event fallback (only if TryoutConfig missing)
  // ─────────────────────────────────────────────────────────────────
  let eventConfig = null;
  if (!tryoutConfig) {
    eventConfig = await EventConfig.findOne({
      eventType: 'tryout',
      isActive: true,
    })
      .sort({ startDate: -1, updatedAt: -1 })
      .lean();

    console.log(
      '[aiEmailService] EventConfig fallback:',
      eventConfig ? `found "${eventConfig.title}"` : 'none',
    );
  }

  // Nothing anywhere
  if (!tryoutConfig && !eventConfig) {
    return null;
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. Normalize sessions from TryoutConfig (the important part)
  // ─────────────────────────────────────────────────────────────────
  const details = tryoutConfig?.tryoutDetails || {};
  const rawSessions = Array.isArray(details.tryoutSessions)
    ? details.tryoutSessions
    : [];

  const sessions = rawSessions
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map((s) => ({
      number: s.number ?? null,
      date: s.date || '',
      startTime: (s.startTime || '').trim(),
      endTime: (s.endTime || '').trim(),
      grades: s.grades || '',
      location: {
        name: s.location?.name || '',
        address: s.location?.address || '',
        city: s.location?.city || '',
        state: s.location?.state || '',
        zip: s.location?.zipCode || s.location?.zip || '',
      },
    }));

  // Prefer a session location (it's usually more specific than the header location)
  const firstSessionLocation =
    sessions.find((s) => s.location?.name || s.location?.address)?.location ||
    null;

  const headerLocation = details.location || {};
  const eventLocation = eventConfig?.location || {};

  const location = {
    name:
      firstSessionLocation?.name ||
      headerLocation.name ||
      eventLocation.name ||
      '',
    address:
      firstSessionLocation?.address ||
      headerLocation.address ||
      eventLocation.address ||
      '',
    city:
      firstSessionLocation?.city ||
      headerLocation.city ||
      eventLocation.city ||
      '',
    state:
      firstSessionLocation?.state ||
      headerLocation.state ||
      eventLocation.state ||
      '',
    zip:
      firstSessionLocation?.zip ||
      headerLocation.zipCode ||
      eventLocation.zip ||
      '',
  };

  // ─────────────────────────────────────────────────────────────────
  // 4. Build the merged response
  // ─────────────────────────────────────────────────────────────────
  const source = tryoutConfig ? 'TryoutConfig' : 'EventConfig';

  return {
    source,

    title:
      tryoutConfig?.displayName ||
      tryoutConfig?.tryoutName ||
      eventConfig?.title ||
      'Bothell Select Tryouts',

    description: tryoutConfig?.description || eventConfig?.description || '',

    // TryoutConfig stores date as a friendly string ("Sunday, September 27th").
    // EventConfig stores it as ISODate. Keep both normalized.
    startDate:
      details.startDate ||
      tryoutConfig?.registrationDeadline ||
      eventConfig?.startDate ||
      null,

    endDate: details.endDate || eventConfig?.endDate || null,

    // Header-level time window — only meaningful when there are NO sessions
    startTime: eventConfig?.startTime || '',
    endTime: eventConfig?.endTime || '',

    // Per-session detail — this is what actually answers the parent's question
    sessions,

    location,

    gender: details.gender || eventConfig?.gender || '',
    grades: eventConfig?.grades || '',

    ageGroups:
      details.ageGroups ||
      tryoutConfig?.ageGroups ||
      eventConfig?.ageGroups ||
      [],

    price: tryoutConfig?.tryoutFee ?? eventConfig?.price ?? null,

    registrationOpen: eventConfig?.registrationOpen ?? true,

    registrationDeadline: tryoutConfig?.registrationDeadline || null,
    paymentDeadline: tryoutConfig?.paymentDeadline || null,
    refundPolicy: tryoutConfig?.refundPolicy || '',

    dropOffTime: details.dropOffTime || '',
    pickUpTime: details.pickUpTime || '',
    contactEmail: details.contactEmail || '',

    hasLimitedSpots: details.hasLimitedSpots ?? false,

    whatToBring: details.whatToBring || eventConfig?.whatToBring || [],
    whatToExpect: eventConfig?.whatToExpect || '',
    importantNotes: eventConfig?.importantNotes || details.notes || [],
  };
}

// General FAQ lookup. Pass a keyword to filter by category/question/answer
// text; omit it to return every FAQ. Used for general "how does X work"
// questions that aren't about a specific family's data.
async function getFaqs(query) {
  const faqs = await FAQ.find({}).lean();

  const normalized = faqs.map((f) => ({
    category: f.category || '',
    questions: f.questions || [],
    answers: f.answers || [],
  }));

  if (!query || !String(query).trim()) return normalized;

  const q = String(query).toLowerCase();
  return normalized.filter(
    (f) =>
      f.category.toLowerCase().includes(q) ||
      f.questions.some((qq) => qq.toLowerCase().includes(q)) ||
      f.answers.some((a) => a.toLowerCase().includes(q)),
  );
}

// Renders getCurrentTryoutInfo()'s result as plain text for direct injection
// into the system prompt, so the model always has it without needing to
// decide to call a tool for it.
function formatTryoutInfoBlock(tryoutInfo) {
  if (!tryoutInfo) {
    return "No active tryout is currently configured in the system. If asked about tryout date, time, or location, say plainly that you don't have that detail and an administrator will confirm it — do not guess.";
  }

  const {
    title,
    startDate,
    startTime,
    endTime,
    location,
    price,
    grades,
    gender,
    registrationOpen,
    sessions,
    dropOffTime,
    whatToBring,
    whatToExpect,
    importantNotes,
    registrationDeadline,
    paymentDeadline,
    refundPolicy,
    contactEmail,
    source,
  } = tryoutInfo;

  const dateStr = startDate
    ? startDate instanceof Date || !Number.isNaN(Date.parse(startDate))
      ? new Date(startDate).toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        })
      : String(startDate)
    : 'not set';

  const locationStr =
    [
      location?.name,
      location?.address,
      location?.city
        ? `${location.city}, ${location.state} ${location.zip}`.trim()
        : '',
    ]
      .filter(Boolean)
      .join(', ') || 'not set';

  const lines = [
    `(Source: ${source})`,
    `Title: ${title || 'not set'}`,
    `Date: ${dateStr}`,
    `Location: ${locationStr}`,
    `Grades: ${grades || 'not set'}`,
    `Gender: ${gender || 'not set'}`,
    `Price: ${price != null ? `$${price}` : 'not set'}`,
    `Registration open: ${registrationOpen ? 'yes' : 'no'}`,
  ];

  // ── Session schedule (the important part) ──
  if (sessions && sessions.length > 0) {
    lines.push('');
    lines.push('TRYOUT SESSIONS (authoritative — use these exact times):');
    sessions.forEach((s, i) => {
      const sessLoc =
        [
          s.location?.name,
          s.location?.address,
          s.location?.city
            ? `${s.location.city}, ${s.location.state} ${s.location.zip}`.trim()
            : '',
        ]
          .filter(Boolean)
          .join(', ') || locationStr;

      lines.push(
        `  ${i + 1}. ${s.grades || 'all grades'} — ${s.date || dateStr}: ` +
          `${s.startTime || '?'} – ${s.endTime || '?'} at ${sessLoc}`,
      );
    });
    lines.push(
      'If a parent asks about a specific grade/gender, answer with the matching session above. Do NOT use a general time window.',
    );
  } else if (startTime && endTime) {
    lines.push(`Time (general window): ${startTime} – ${endTime}`);
  } else {
    lines.push(
      'Time: not set at session level — an administrator will confirm.',
    );
  }

  if (dropOffTime) lines.push(`Drop-off: ${dropOffTime}`);
  if (registrationDeadline) {
    lines.push(
      `Registration deadline: ${new Date(registrationDeadline).toDateString()}`,
    );
  }
  if (paymentDeadline) {
    lines.push(`Payment deadline: ${new Date(paymentDeadline).toDateString()}`);
  }
  if (refundPolicy) lines.push(`Refund policy: ${refundPolicy}`);
  if (whatToBring && whatToBring.length) {
    lines.push(`What to bring: ${whatToBring.join(', ')}`);
  }
  if (whatToExpect) lines.push(`What to expect: ${whatToExpect}`);
  if (importantNotes && importantNotes.length) {
    lines.push(`Important notes: ${importantNotes.join('; ')}`);
  }
  if (contactEmail) lines.push(`Contact: ${contactEmail}`);

  return lines.join('\n');
}

// Returns just the first token of a full name, for use in salutations
// ("Hello Jane," not "Hello Jane Smith,"). Computed in code rather than
// left to the model, for the same reliability reason as the other
// deterministic blocks above.
function getFirstName(fullName) {
  if (!fullName) return '';
  return String(fullName).trim().split(/\s+/)[0] || '';
}

// Renders the parent + family lookup as plain text for direct injection
// into the system prompt, so the model always has the correct parent
// identity up front and never has to infer who to address from a child's
// name, the email address, or the message body.
function formatFamilyContextBlock(parentSummary, family) {
  if (!parentSummary || !family || !family.parentFound) {
    return (
      'No parent account matches this sender email address. Use a neutral ' +
      'greeting ("Hello,") — do NOT guess a name from the email address or ' +
      'the message body. Tell the administrator this needs manual verification.'
    );
  }

  const greetingName = getFirstName(parentSummary.fullName);

  const lines = [
    `ADDRESS THIS PARENT AS: ${greetingName || '(name not on file — use "Hello,")'}`,
    `Parent full name (for internal reference only — do NOT use the last name in the greeting): ${parentSummary.fullName || 'not set'}`,
    `Parent email: ${parentSummary.email || 'not set'}`,
    `Parent phone: ${parentSummary.phone || 'not set'}`,
  ];

  if (!family.players || family.players.length === 0) {
    lines.push('Children on file: none');
  } else {
    lines.push('Children on file (NEVER use these names to greet the parent):');
    family.players.forEach((p) => {
      const seasonsStr = (p.seasons || [])
        .map((s) => {
          const parts = [
            `${s.season || 'unknown season'} ${s.year || ''}`.trim(),
          ];
          parts.push(`payment: ${s.paymentStatus || 'unknown'}`);
          if (s.amountPaid != null) parts.push(`$${s.amountPaid} paid`);
          if (s.paymentDate) {
            parts.push(`paid ${new Date(s.paymentDate).toDateString()}`);
          }
          if (s.cardLast4) parts.push(`card ending ${s.cardLast4}`);
          return parts.join(', ');
        })
        .join(' | ');

      lines.push(
        `  - ${p.fullName || 'unnamed player'} (grade ${p.grade || 'unknown'}, gender ${p.gender || 'unknown'}): ` +
          `registrationComplete=${p.registrationComplete}, paymentComplete=${p.paymentComplete}` +
          `${seasonsStr ? ` — seasons: ${seasonsStr}` : ''}`,
      );
    });
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractJsonFromText(rawOutput) {
  if (!rawOutput) throw new Error('Empty AI output');

  let cleaned = String(rawOutput).trim();
  cleaned = cleaned.replace(/^\uFEFF/, '');

  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```\s*$/i, '');
  }

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error(
      `No JSON object found in AI output. Raw: ${cleaned.slice(0, 300)}`,
    );
  }

  cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  return JSON.parse(cleaned);
}

const ALLOWED_CATEGORIES = [
  'tryouts',
  'registration',
  'payments',
  'schedules',
  'teams',
  'practices',
  'programs',
  'technical',
  'general',
  'other',
];

// ─────────────────────────────────────────────────────────────────────────────
// AI draft generation (Chat Completions + tool calling)
// ─────────────────────────────────────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_parent_by_email',
      description:
        'Find the parent account in the Bothell Select database using the sender email address. Returns null if no parent matches.',
      parameters: {
        type: 'object',
        properties: {
          email: { type: 'string', description: 'The sender email address.' },
        },
        required: ['email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_family_data',
      description:
        'Get the players, registrations, payments, and teams for a parent, using the parentId returned by get_parent_by_email.',
      parameters: {
        type: 'object',
        properties: {
          parentId: {
            type: 'string',
            description: 'The parent id returned by get_parent_by_email.',
          },
        },
        required: ['parentId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_current_tryout_info',
      description:
        'Get the authoritative date, time, location, price, eligible grades/ages, per-session schedule, and what-to-bring details for the current active tryout. Prefers TryoutConfig, falls back to EventConfig. Returns null if no active tryout is configured. This is the only reliable source for tryout logistics — never guess or infer these from registration/payment data.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_faqs',
      description:
        'Search the Bothell Select FAQ database for answers to general, non-family-specific questions (e.g. how sessions run, policies, program logistics). Pass a keyword to filter, or omit it to see all FAQs.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Optional keyword to filter FAQs by category, question, or answer text.',
          },
        },
      },
    },
  },
];

async function executeToolCall(call, toolContext) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch (err) {
    console.warn('Failed to parse tool arguments:', call.function.arguments);
  }

  if (call.function.name === 'get_parent_by_email') {
    const result = await getParentByEmail(args.email);
    toolContext.parent = result;
    return result;
  }

  if (call.function.name === 'get_family_data') {
    const result = await getFamilyData(args.parentId);
    toolContext.family = result;
    return result;
  }

  if (call.function.name === 'get_current_tryout_info') {
    const result = await getCurrentTryoutInfo();
    toolContext.tryoutInfo = result;
    return result;
  }

  if (call.function.name === 'get_faqs') {
    const result = await getFaqs(args.query);
    toolContext.faqs = result;
    return result;
  }

  return { error: `Unknown tool: ${call.function.name}` };
}

function buildSystemPrompt(settings, tryoutInfo, parentSummary, family) {
  const currentSeasonLine = CURRENT_TRYOUT_YEAR
    ? `
CURRENT SEASON
The current / upcoming season is "${CURRENT_TRYOUT_LABEL}" for year ${CURRENT_TRYOUT_YEAR}${
        CURRENT_TRYOUT_ID ? ` (tryoutId: ${CURRENT_TRYOUT_ID})` : ''
      }.
When a parent asks about "upcoming", "current", or "this year's" tryouts,
that refers to this season.
`.trim()
    : '';

  const tryoutInfoBlock = formatTryoutInfoBlock(tryoutInfo);
  const familyContextBlock = formatFamilyContextBlock(parentSummary, family);

  return `
You are the Bothell Select parent email assistant.

Your job is to analyze an incoming email from a parent and prepare a
professional draft response for a Bothell Select administrator.

FAMILY CONTEXT (authoritative — already looked up for you from the sender's
email address; use this directly, without needing to call a tool for it)
${familyContextBlock}

CURRENT TRYOUT DETAILS (authoritative — already looked up for you; use this
directly for any question about tryout date, time, location, price, grades,
or what to bring, without needing to call a tool for it)
${tryoutInfoBlock}

If a parent asks about tryout date/time/location and the block above says a
detail is "not set" or that no active tryout is configured, say plainly
that you don't have that detail and an administrator will confirm it — do
NOT guess, and do NOT substitute an unrelated fact (like registration
status) as if it answers the question.

If the CURRENT TRYOUT DETAILS block contains a "TRYOUT SESSIONS" list, you
MUST use the specific session that matches the parent's grade and gender
(e.g. "Boys: grades 6th, 7th, & 8th — September 27th: 3:00 pm – 4:30 pm").
Do NOT answer with the general time window when session detail is available.

You also have access to three tools backed by the live database, for cases
the blocks above don't cover:
- get_parent_by_email / get_family_data: only needed if the parent's
  message refers to a DIFFERENT family than the sender's own (e.g. asking
  on behalf of another guardian) — the sender's own family is already
  provided above, don't call these for it.
- get_faqs: search general FAQ content for non-family-specific questions.
- get_current_tryout_info: only needed if the parent is asking about a
  different or past tryout than the one detailed above — the current one
  is already provided, don't call this tool for it.

If the parent asks a general question that isn't about their own family's
registration or payment (e.g. how sessions run, program policies, "how
many kids per session"), call get_faqs with a relevant keyword before
answering. If no keyword comes to mind, call it with no query to see all
FAQs.

${currentSeasonLine}

IMPORTANT RULES

1. Never invent facts. Only use what the blocks above or the tools return.
2. Match children by fullName within the FAMILY CONTEXT block. Common
   nicknames (Theo/Theodore, Alex/Alexander, etc.) may match — use context.
3. Greet the parent using EXACTLY the name in "ADDRESS THIS PARENT AS"
   above — e.g. "Hello Jane,". NEVER greet the parent using a child's
   fullName from the "Children on file" list, even if it looks similar to
   the sender's email address or a name mentioned in the message body —
   parents and children are different people with different names, and
   mixing them up is a real error, not a style choice. If the FAMILY
   CONTEXT block says no parent account was found, use a neutral greeting
   like "Hello," instead of guessing a name from the email address.
4. To answer "is my child registered?", check that child's
   registrationComplete field (both on the player and within their
   registrations for the current season).
5. To answer "did I pay?", check paymentComplete / paymentStatus for that
   child's current-season registration, and include amountPaid,
   paymentDate, and cardLast4 when confirming.
6. When the data unambiguously confirms what the parent asked (e.g.
   registrationComplete: true AND the current-season registration has
   paymentComplete: true for the exact child they mentioned), confirm it
   directly and confidently. Do NOT hedge with "appears to be" or
   "according to our records."
7. If the FAMILY CONTEXT block shows no parent record, or the child the
   parent asked about isn't listed there, say the administrator needs to
   verify it manually — do NOT guess, and set confidence to 20 or lower.
8. If the CURRENT TRYOUT DETAILS block above is missing the specific detail
   the parent asked about, say plainly that you don't have that detail and
   an administrator will confirm it — do NOT guess, and do NOT answer with
   an unrelated fact (like registration status) instead. Set confidence to
   20 or lower for that part of the question. When the block DOES have the
   detail, answer it directly and confidently — don't hedge or defer to an
   administrator for something you were already given.
9. Do not expose passwords or internal MongoDB ids.
10. Do not make team placement decisions or approve refunds.
11. Sound like a helpful Bothell Select administrator. Be warm and concise.
12. Sign the response as "Bothell Select Basketball".

CONFIDENCE
"confidence" must reflect whether you actually had the data to answer the
parent's question — not just whether you picked the right category. If no
parent was found, the child asked about isn't in the family data, or a
logistics question couldn't be answered from the CURRENT TRYOUT DETAILS
block, confidence must be 20 or lower, regardless of how clear the
category is.

Once you have gathered whatever data is available (or confirmed none
exists), respond with ONLY valid JSON, no markdown fences, no text before
or after it, in exactly this shape:

{
  "category": "one of: ${ALLOWED_CATEGORIES.join(', ')}",
  "confidence": 0,
  "draft": "draft response",
  "reason": "short explanation of category and confidence",
  "dataUsed": ["parent", "players", "registrations", "payments", "tryoutInfo", "faqs"],
  "requiresHumanReview": true,
  "reviewReason": "why a human should review this response"
}

Confidence must be 0-100.
Settings: tone=${settings.tone}, confidenceThreshold=${settings.confidenceThreshold}, automaticRepliesEnabled=${settings.automaticRepliesEnabled}
`.trim();
}

async function generateAiDraft({ from, subject = '', body }) {
  if (!from) throw new Error('from is required');
  if (!body) throw new Error('body is required');

  const settings = await getAiSettings();
  const tryoutInfo = await getCurrentTryoutInfo();
  const parentSummary = await getParentByEmail(from);
  const family = parentSummary
    ? await getFamilyData(parentSummary.id)
    : await buildParentContext(null);
  const systemPrompt = buildSystemPrompt(
    settings,
    tryoutInfo,
    parentSummary,
    family,
  );

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `From: ${from}\nSubject: ${subject}\n\nMessage:\n${body}`,
    },
  ];

  const toolContext = { tryoutInfo, parent: parentSummary, family };
  let iterations = 0;
  const MAX_ITERATIONS = 6;
  let finalMessage = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;

    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: 2000,
    });

    const choice = completion.choices && completion.choices[0];
    if (!choice) throw new Error('OpenAI returned no choices');

    const message = choice.message;
    messages.push(message);

    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const call of message.tool_calls) {
        let result;
        try {
          result = await executeToolCall(call, toolContext);
        } catch (err) {
          console.error('Tool execution failed:', err);
          result = { error: err.message };
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    finalMessage = message;
    break;
  }

  if (!finalMessage) {
    throw new Error(
      `AI did not finish within ${MAX_ITERATIONS} tool-calling iterations`,
    );
  }

  const rawOutput = finalMessage.content || '';
  if (!rawOutput) throw new Error('OpenAI returned an empty final message');

  console.log('=== AI RAW OUTPUT (first 500 chars) ===');
  console.log(rawOutput.slice(0, 500));
  console.log('=======================================');

  let result;
  try {
    result = extractJsonFromText(rawOutput);
  } catch (parseError) {
    console.error('JSON extraction failed:', parseError.message);
    throw new Error(`OpenAI returned invalid JSON: ${parseError.message}`);
  }

  if (!ALLOWED_CATEGORIES.includes(result.category)) {
    result.category = 'other';
  }
  result.confidence = Math.max(
    0,
    Math.min(100, Number(result.confidence) || 0),
  );
  if (!Array.isArray(result.dataUsed)) result.dataUsed = [];
  if (!result.draft) {
    result.draft =
      'Thank you for contacting Bothell Select. We will review your message and get back to you shortly.';
  }
  if (!result.reason) {
    result.reason = 'AI generated a draft for administrative review.';
  }
  if (!result.reviewReason) {
    result.reviewReason = 'Human review is required.';
  }

  const context = toolContext.family || {
    parentFound: false,
    parent: null,
    players: [],
    registrations: [],
    payments: [],
  };

  if (!context.parentFound) {
    result.confidence = Math.min(result.confidence, 20);
    result.requiresHumanReview = true;
    result.reviewReason =
      'No matching parent record found for this email address — verify manually.';
  }

  return {
    ...result,
    parent: toolContext.parent || null,
    context,
    tryoutInfo: toolContext.tryoutInfo || null,
    faqs: toolContext.faqs || null,
    effectiveEmail: from,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-send eligibility + sending
// ─────────────────────────────────────────────────────────────────────────────

async function evaluateAutoSendEligibility(aiEmail) {
  const settings = await getAiSettings();

  if (!settings.enabled) {
    return { eligible: false, reason: 'AI assistant is disabled.' };
  }
  if (!settings.automaticRepliesEnabled) {
    return { eligible: false, reason: 'Automatic replies are disabled.' };
  }
  if (aiEmail.confidence < settings.confidenceThreshold) {
    return {
      eligible: false,
      reason: `Confidence ${aiEmail.confidence}% is below threshold ${settings.confidenceThreshold}%.`,
    };
  }
  if (settings.alwaysRequireHumanReview.includes(aiEmail.category)) {
    return {
      eligible: false,
      reason: `Category "${aiEmail.category}" always requires human review.`,
    };
  }
  if (
    Array.isArray(settings.allowedAutomaticCategories) &&
    settings.allowedAutomaticCategories.length > 0 &&
    !settings.allowedAutomaticCategories.includes(aiEmail.category)
  ) {
    return {
      eligible: false,
      reason: `Category "${aiEmail.category}" is not in the allowed automatic categories.`,
    };
  }
  return { eligible: true, reason: 'All auto-send conditions met.' };
}

async function sendAiReply(aiEmail) {
  const body = aiEmail.humanEditedDraft || aiEmail.aiDraft;
  if (!body) throw new Error('No draft body available to send.');

  const headers = {};
  if (aiEmail.messageId) {
    headers['In-Reply-To'] = aiEmail.messageId;
    headers['References'] = aiEmail.messageId;
  }

  const subject = aiEmail.subject
    ? `Re: ${aiEmail.subject.replace(/^Re:\s*/i, '')}`
    : 'Re: Your message to Bothell Select';

  const replyTarget = aiEmail.replyToEmail || aiEmail.from;

  const { data, error } = await resend.emails.send({
    from: VERIFIED_SENDER,
    to: replyTarget,
    subject,
    text: body,
    headers,
  });

  if (error) throw new Error(error.message || 'Resend send failed');
  return data?.id || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

async function processIncomingEmail(emailData) {
  const normalizedFrom = extractEmailAddress(emailData.from);
  let resolvedEmailData = emailData;

  if (SITE_OWNED_EMAILS.has(normalizedFrom)) {
    const bodyEmail = extractEmailFromBody(emailData.body);
    if (bodyEmail && !SITE_OWNED_EMAILS.has(bodyEmail)) {
      console.log(
        `"from" was site-owned ("${normalizedFrom}"); replacing with body email "${bodyEmail}".`,
      );
      resolvedEmailData = { ...emailData, from: bodyEmail };
    } else {
      console.log(
        `"from" was site-owned ("${normalizedFrom}") and no usable body email was found.`,
      );
    }
  }

  console.log('=== PROCESSING EMAIL ===');
  console.log('From:', resolvedEmailData.from);
  console.log('Subject:', resolvedEmailData.subject);
  console.log('Body length:', (resolvedEmailData.body || '').length);

  const aiEmail = await createAiEmail(resolvedEmailData);
  console.log('Created AiEmail:', aiEmail._id.toString());

  try {
    console.log('Calling generateAiDraft...');
    const result = await generateAiDraft({
      from: resolvedEmailData.from,
      subject: resolvedEmailData.subject || '',
      body: resolvedEmailData.body,
    });

    console.log('AI result summary:', {
      category: result.category,
      confidence: result.confidence,
      hasParent: !!result.parent,
      parentFound: result.context?.parentFound,
      playerCount: result.context?.players?.length || 0,
      hasTryoutInfo: !!result.tryoutInfo,
      tryoutSource: result.tryoutInfo?.source || null,
      sessionCount: result.tryoutInfo?.sessions?.length || 0,
      faqMatches: result.faqs ? result.faqs.length : 0,
    });

    aiEmail.category = result.category;
    aiEmail.confidence = result.confidence;
    aiEmail.aiDraft = result.draft;
    aiEmail.aiReason = result.reason;
    aiEmail.dataUsed = result.dataUsed;
    aiEmail.replyToEmail = result.effectiveEmail || resolvedEmailData.from;

    if (result.parent) {
      aiEmail.parentId = result.parent.id || result.parent._id || null;
    }
    if (result.context.players) {
      aiEmail.playerIds = result.context.players
        .filter((p) => p.id)
        .map((p) => p.id);
    }
    if (result.context.registrations) {
      aiEmail.registrationIds = result.context.registrations
        .filter((r) => r.playerId)
        .map((r) => r.playerId);
    }
    if (result.context.payments) {
      aiEmail.paymentIds = result.context.payments
        .filter((p) => p.paymentId)
        .map((p) => p.paymentId);
    }

    const eligibility = await evaluateAutoSendEligibility(aiEmail);

    if (eligibility.eligible) {
      try {
        const sentMessageId = await sendAiReply(aiEmail);
        aiEmail.status = 'sent';
        aiEmail.requiresHumanReview = false;
        aiEmail.finalResponse = aiEmail.aiDraft;
        aiEmail.sentAt = new Date();
        aiEmail.sentMessageId = sentMessageId;
        aiEmail.autoSent = true;
        aiEmail.reviewReason = `Auto-sent. ${eligibility.reason}`;
      } catch (sendError) {
        console.error('Auto-send failed:', sendError.message);
        aiEmail.status = 'draft_ready';
        aiEmail.requiresHumanReview = true;
        aiEmail.reviewReason = `Auto-send failed: ${sendError.message}`;
      }
    } else {
      aiEmail.status = 'draft_ready';
      aiEmail.requiresHumanReview = true;
      aiEmail.reviewReason = eligibility.reason;
    }

    await aiEmail.save();
    console.log('AiEmail saved with status:', aiEmail.status);
    return aiEmail;
  } catch (error) {
    console.error('=== AI PROCESSING FAILED ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('============================');

    aiEmail.status = 'new';
    aiEmail.requiresHumanReview = true;
    aiEmail.reviewReason = `AI processing failed: ${error.message}`;
    aiEmail.aiDraft =
      aiEmail.aiDraft ||
      `[AI draft failed] ${error.message}\n\nOriginal message:\n${resolvedEmailData.body}`;
    aiEmail.category = aiEmail.category || 'other';
    aiEmail.confidence = aiEmail.confidence || 0;

    try {
      await aiEmail.save();
      console.log('Saved fallback AiEmail (status=new) after AI failure.');
    } catch (saveError) {
      console.error(
        'CRITICAL: Failed to save AiEmail after AI failure:',
        saveError.message,
      );
    }

    throw error;
  }
}

async function manualSendAiEmail(aiEmail, { draft, reviewedBy } = {}) {
  if (!aiEmail) throw new Error('AI email not found');
  if (aiEmail.status === 'sent') throw new Error('Email has already been sent');

  if (typeof draft === 'string' && draft.trim()) {
    aiEmail.humanEditedDraft = draft.trim();
  }

  const sentMessageId = await sendAiReply(aiEmail);

  aiEmail.status = 'sent';
  aiEmail.requiresHumanReview = false;
  aiEmail.finalResponse = aiEmail.humanEditedDraft || aiEmail.aiDraft;
  aiEmail.sentAt = new Date();
  aiEmail.sentMessageId = sentMessageId;
  aiEmail.autoSent = false;
  if (reviewedBy) {
    aiEmail.reviewedBy = reviewedBy;
    aiEmail.reviewedAt = new Date();
  }

  await aiEmail.save();
  return aiEmail;
}

module.exports = {
  getAiSettings,
  updateAiSettings,

  findParent,
  findParentById,
  findPlayersByParent,
  findPlayer,
  findRegistrationsByPlayer,
  findRegistrationsByParent,
  findPaymentsByParent,
  findPaymentsByPlayer,
  findPaymentsByTeam,
  findTeam,
  findTeamsByCoach,

  createAiEmail,
  getPendingAiEmails,
  getAllAiEmails,
  getAiEmailById,

  getParentByEmail,
  getFamilyData,
  getCurrentTryoutInfo,
  getFaqs,
  buildParentContext,
  generateAiDraft,
  processIncomingEmail,

  evaluateAutoSendEligibility,
  sendAiReply,
  manualSendAiEmail,

  extractJsonFromText,
  extractEmailAddress,
  extractEmailFromBody,
};
