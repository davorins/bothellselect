require('dotenv').config();

const mongoose = require('mongoose');
const OpenAI = require('openai');
const { Resend } = require('resend');

const AiEmail = require('../models/AiEmail');
const AiSettings = require('../models/AiSettings');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const PlayerRegistration = require('../models/PlayerRegistration');
const Payment = require('../models/Payment');
const Team = require('../models/Team');
const TournamentConfig = require('../models/TournamentConfig');

if (!process.env.OPENAI_API_KEY) {
  console.warn('[aiEmailService] OPENAI_API_KEY is not set.');
}

if (!process.env.RESEND_API_KEY) {
  console.warn('[aiEmailService] RESEND_API_KEY is not set.');
}

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const VERIFIED_SENDER =
  process.env.VERIFIED_SENDER || 'Bothell Select <info@bothellselect.com>';

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const SITE_OWNED_EMAILS = new Set(
  [
    'info@bothellselect.com',
    'bothellselect@proton.me',
    process.env.VERIFIED_SENDER_EMAIL,
  ]
    .filter(Boolean)
    .map((e) => e.toLowerCase()),
);

const ADDITIONAL_ALLOWED_DOMAINS = (process.env.AI_ALLOWED_DOMAINS || '')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

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

function normalizeIdList(value) {
  if (value == null) return [];

  if (Array.isArray(value)) {
    return value
      .flat(Infinity)
      .map((v) => (v == null ? '' : String(v).trim()))
      .filter(Boolean);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();

    if (!trimmed) return [];

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);

        if (Array.isArray(parsed)) {
          return normalizeIdList(parsed);
        }
      } catch {
        // Continue as normal string.
      }
    }

    return [trimmed];
  }

  return [String(value).trim()].filter(Boolean);
}

async function getAiSettings() {
  let settings = await AiSettings.findOne({
    key: 'default',
  });

  if (!settings) {
    settings = await AiSettings.create({
      key: 'default',
    });
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
    if (key in updates) {
      settings[key] = updates[key];
    }
  }

  if (updatedBy) {
    settings.updatedBy = updatedBy;
  }

  await settings.save();

  return settings;
}

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

  if (labeledMatch) {
    return labeledMatch[1].toLowerCase().trim();
  }

  const anyMatch = String(body).match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  );

  return anyMatch ? anyMatch[0].toLowerCase().trim() : '';
}

function isTryoutQuestion(subject = '', body = '') {
  const text = `${subject}\n${body}`.toLowerCase();

  const phrases = [
    'tryout',
    'tryouts',
    'where is',
    'where are',
    'where do',
    'what time',
    'when is',
    'when are',
    'when do',
    'schedule',
    'location',
    'address',
    'fee',
    'cost',
    'price',
    'payment deadline',
    'registration deadline',
    'what to bring',
    'bring',
    'check-in',
    'check in',
  ];

  return phrases.some((phrase) => text.includes(phrase));
}

function isRegistrationQuestion(subject = '', body = '') {
  const text = `${subject}\n${body}`.toLowerCase();

  return [
    'registered',
    'registration',
    'register',
    'sign up',
    'signed up',
    'enrolled',
  ].some((phrase) => text.includes(phrase));
}

function isPaymentQuestion(subject = '', body = '') {
  const text = `${subject}\n${body}`.toLowerCase();

  return [
    'payment',
    'paid',
    'pay',
    'charge',
    'charged',
    'receipt',
    'refund',
    'reimbursement',
    'credit card',
    'card',
  ].some((phrase) => text.includes(phrase));
}

async function shouldProcessEmail(fromEmail) {
  const email = extractEmailAddress(fromEmail);

  if (!email) {
    return {
      process: false,
      reason: 'No sender email address.',
    };
  }

  const parent = await Parent.findOne({
    email,
  })
    .select('_id')
    .lean();

  if (parent) {
    return {
      process: true,
      reason: 'Known parent.',
    };
  }

  const domain = email.split('@')[1] || '';

  if (ADDITIONAL_ALLOWED_DOMAINS.includes(domain)) {
    return {
      process: true,
      reason: `Allowed domain (${domain}).`,
    };
  }

  return {
    process: false,
    reason: 'Sender is not a registered Bothell Select parent.',
  };
}

async function findParent(email) {
  if (!email) return null;

  return Parent.findOne({
    email: extractEmailAddress(email),
  }).select('-password');
}

async function findParentById(parentId) {
  if (!parentId) return null;

  return Parent.findById(parentId).select('-password');
}

async function findPlayersByParent(parentId) {
  if (!parentId) return [];

  const parent = await Parent.findById(parentId).select('players').lean();

  const playerIdsFromParentArray = (parent?.players || []).map((id) =>
    String(id),
  );

  return Player.find({
    $or: [
      { parentId },
      {
        _id: {
          $in: playerIdsFromParentArray,
        },
      },
    ],
  });
}

async function findPlayer(playerId) {
  if (!playerId) return null;

  return Player.findById(playerId);
}

async function findRegistrationsByPlayer(playerId) {
  if (!playerId) return [];

  return PlayerRegistration.find({
    playerId,
  }).sort({
    createdAt: -1,
  });
}

async function findRegistrationsByParent(parentId) {
  if (!parentId) return [];

  const players = await Player.find({
    parentId,
  }).select('_id');

  const playerIds = players.map((p) => p._id);

  if (playerIds.length === 0) {
    return [];
  }

  return PlayerRegistration.find({
    playerId: {
      $in: playerIds,
    },
  }).sort({
    createdAt: -1,
  });
}

async function findPaymentsByParent(parentId) {
  if (!parentId) return [];

  return Payment.find({
    parentId,
  }).sort({
    createdAt: -1,
  });
}

async function findPaymentsByPlayer(playerId) {
  if (!playerId) return [];

  return Payment.find({
    $or: [
      { playerId },
      { playerIds: playerId },
      { 'players.playerId': playerId },
    ],
  }).sort({
    createdAt: -1,
  });
}

async function findPaymentsByTeam(teamId) {
  if (!teamId) return [];

  return Payment.find({
    $or: [{ teamId }, { teamIds: teamId }],
  }).sort({
    createdAt: -1,
  });
}

async function findTeam(teamId) {
  if (!teamId) return null;

  return Team.findById(teamId);
}

async function findTeamsByCoach(coachId) {
  if (!coachId) return [];

  return Team.find({
    coachIds: coachId,
    isActive: true,
  }).sort({
    registrationYear: -1,
    name: 1,
  });
}

function sortSeasonsDesc(seasons) {
  return [...(seasons || [])].sort((a, b) => {
    const ay = Number(a.year) || 0;
    const by = Number(b.year) || 0;

    if (by !== ay) {
      return by - ay;
    }

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
      registrationId: null,
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
    registrationId: reg._id ? reg._id.toString() : null,

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
    .filter(
      (registration) =>
        registration.paymentId || registration.amountPaid != null,
    )
    .map((registration) => ({
      playerId: registration.playerId,
      playerName: registration.playerName,
      season: registration.season,
      year: registration.year,
      tryoutId: registration.tryoutId,

      paymentId: registration.paymentId ? String(registration.paymentId) : null,

      amountPaid: registration.amountPaid,

      status: registration.paymentStatus,

      paidAt: registration.paymentDate,

      cardLast4: registration.cardLast4,

      cardBrand: registration.cardBrand,
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

      seasons: sortSeasonsDesc(player.seasons).map((season) => ({
        season: season.season || '',
        year: season.year || null,
        tryoutId: season.tryoutId || null,

        registrationDate: season.registrationDate || null,

        paymentComplete: season.paymentComplete || false,

        paymentStatus: season.paymentStatus || 'unknown',

        paymentId: season.paymentId || null,

        amountPaid: season.amountPaid ?? null,

        paymentDate: season.paymentDate || null,

        cardLast4: season.cardLast4 || null,

        cardBrand: season.cardBrand || null,
      })),
    })),

    registrations: allRegistrations,

    payments: allPayments,
  };
}

async function getParentByEmail(email) {
  const parent = await findParent(email);

  if (!parent) {
    return null;
  }

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

async function getCurrentTryout() {
  const config = await TournamentConfig.findOne({
    isActive: true,
  })
    .sort({
      tryoutYear: -1,
      createdAt: -1,
    })
    .lean();

  if (!config) {
    console.warn('[getCurrentTryout] No active TournamentConfig found.');

    return null;
  }

  const details = config.tryoutDetails || {};

  const sessions = (details.tryoutSessions || []).map((session) => ({
    id: session.id ? String(session.id) : null,

    number: session.number ?? null,

    date: session.date || '',

    startTime: String(session.startTime || '').trim(),

    endTime: String(session.endTime || '').trim(),

    grades: session.grades || '',

    location: session.location
      ? {
          name: session.location.name || '',

          address: session.location.address || '',

          city: session.location.city || '',

          state: session.location.state || '',

          zipCode: session.location.zipCode || '',
        }
      : null,
  }));

  const result = {
    id: config._id ? config._id.toString() : null,

    eventId: config.eventId || null,

    tryoutName:
      config.tryoutName || config.displayName || 'Bothell Select Tryouts',

    tryoutYear: config.tryoutYear || null,

    season: config.season || '',

    registrationDeadline: config.registrationDeadline || null,

    paymentDeadline: config.paymentDeadline || null,

    tryoutFee: config.tryoutFee ?? null,

    refundPolicy: config.refundPolicy || '',

    requiresPayment: !!config.requiresPayment,

    requiresInsurance: !!config.requiresInsurance,

    ageGroups: config.ageGroups || [],

    contactEmail: details.contactEmail || '',

    startDate: details.startDate || '',

    endDate: details.endDate || '',

    gender: details.gender || '',

    dropOffTime: details.dropOffTime || '',

    pickUpTime: details.pickUpTime || '',

    whatToBring: details.whatToBring || [],

    notes: details.notes || [],

    hasLimitedSpots: !!details.hasLimitedSpots,

    maxParticipants: details.maxParticipants ?? null,

    sessions,
  };

  console.log('[getCurrentTryout] Loaded active TournamentConfig:', {
    database: mongoose.connection.name,
    host: mongoose.connection.host,
    id: result.id,
    eventId: result.eventId,
    tryoutYear: result.tryoutYear,
    tryoutName: result.tryoutName,
    sessionCount: result.sessions.length,
  });

  console.log(
    '[getCurrentTryout] Sessions:',
    JSON.stringify(result.sessions, null, 2),
  );

  return result;
}

function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const COMMON_NICKNAMES = {
  theo: ['theodore'],
  theodore: ['theo'],

  alex: ['alexander', 'alexandra'],
  alexander: ['alex'],
  alexandra: ['alex'],

  ari: ['ariana'],
  ariana: ['ari'],

  mike: ['michael'],
  michael: ['mike'],

  matt: ['matthew'],
  matthew: ['matt'],

  nick: ['nicholas'],
  nicholas: ['nick'],

  dan: ['daniel'],
  daniel: ['dan'],

  ben: ['benjamin'],
  benjamin: ['ben'],

  sam: ['samuel', 'samantha'],
  samuel: ['sam'],
  samantha: ['sam'],
};

function namesMatch(nameA, nameB) {
  const a = normalizeName(nameA);
  const b = normalizeName(nameB);

  if (!a || !b) return false;

  if (a === b) return true;

  const aParts = a.split(' ');
  const bParts = b.split(' ');

  if (
    aParts.length > 0 &&
    bParts.length > 0 &&
    aParts[0] === bParts[0] &&
    aParts[aParts.length - 1] === bParts[bParts.length - 1]
  ) {
    return true;
  }

  const aFirst = aParts[0];
  const bFirst = bParts[0];

  if (
    COMMON_NICKNAMES[aFirst]?.includes(bFirst) ||
    COMMON_NICKNAMES[bFirst]?.includes(aFirst)
  ) {
    const aLast = aParts[aParts.length - 1];

    const bLast = bParts[bParts.length - 1];

    return aLast === bLast;
  }

  return false;
}

function detectGenderTerm(text) {
  const lower = String(text || '').toLowerCase();

  if (/\b(my\s+)?son\b/.test(lower) || /\bboys?\b/.test(lower)) {
    return 'Male';
  }

  if (/\b(my\s+)?daughter\b/.test(lower) || /\bgirls?\b/.test(lower)) {
    return 'Female';
  }

  return null;
}

function findNamedPlayers(text, players) {
  const matches = [];

  for (const player of players) {
    if (player.fullName && namesMatch(player.fullName, text)) {
      matches.push(player);
    }
  }

  return matches;
}

function resolveRelevantPlayers(subject, body, players) {
  const text = `${subject}\n${body}`;

  if (!players || players.length === 0) {
    return {
      players: [],
      reason: 'No players found.',
      ambiguous: false,
    };
  }

  const named = findNamedPlayers(text, players);

  if (named.length > 0) {
    return {
      players: named,
      reason: 'Matched by player name.',
      ambiguous: named.length > 1,
    };
  }

  const gender = detectGenderTerm(text);

  if (gender) {
    const matches = players.filter(
      (player) =>
        String(player.gender || '').toLowerCase() === gender.toLowerCase(),
    );

    if (matches.length > 0) {
      return {
        players: matches,
        reason: `Matched by gender term (${gender}).`,
        ambiguous: matches.length > 1,
      };
    }

    return {
      players: [],
      reason: `No child matched gender term (${gender}).`,
      ambiguous: false,
    };
  }

  return {
    players,
    reason: 'No specific child identified; using all family players.',
    ambiguous: players.length > 1,
  };
}

function normalizeGrade(grade) {
  return String(grade || '')
    .toLowerCase()
    .replace(/grade/g, '')
    .replace(/th|st|nd|rd/g, '')
    .trim();
}

function sessionMatchesPlayer(session, player) {
  if (!session || !player) return false;

  const grades = String(session.grades || '').toLowerCase();

  const gender = String(player.gender || '').toLowerCase();

  const grade = normalizeGrade(player.grade);

  let genderMatches = true;

  if (grades.includes('girls')) {
    genderMatches = gender === 'female';
  } else if (grades.includes('boys')) {
    genderMatches = gender === 'male';
  }

  if (!genderMatches) {
    return false;
  }

  if (!grade) {
    return false;
  }

  if (
    grades.includes('4th') &&
    grades.includes('5th') &&
    !grades.includes('6th')
  ) {
    return ['4', '5'].includes(grade);
  }

  if (grades.includes('4th') && grades.includes('8th')) {
    return ['4', '5', '6', '7', '8'].includes(grade);
  }

  if (
    grades.includes('6th') &&
    grades.includes('7th') &&
    grades.includes('8th')
  ) {
    return ['6', '7', '8'].includes(grade);
  }

  return false;
}

function attachTryoutSessionsToPlayers(family, tryout) {
  if (!family || !tryout) return family;

  const players = (family.players || []).map((player) => {
    const matchingSessions = (tryout.sessions || []).filter((session) =>
      sessionMatchesPlayer(session, player),
    );

    return {
      ...player,
      currentTryoutSessions: matchingSessions,
    };
  });

  return {
    ...family,
    players,
  };
}

async function populateAiEmail(query) {
  const doc = await query.populate({
    path: 'parentId',
    select: 'fullName email',
  });

  if (!doc) return doc;

  const docs = Array.isArray(doc) ? doc : [doc];

  const allPlayerIds = [
    ...new Set(
      docs.flatMap((d) => (d.playerIds || []).map((id) => String(id))),
    ),
  ].filter((id) => mongoose.Types.ObjectId.isValid(id));

  let byId = new Map();

  if (allPlayerIds.length > 0) {
    const players = await Player.find({
      _id: {
        $in: allPlayerIds,
      },
    }).select('fullName');

    byId = new Map(players.map((p) => [String(p._id), p.fullName]));
  }

  for (const d of docs) {
    d.playerIds = (d.playerIds || []).map((id) => ({
      _id: String(id),
      fullName: byId.get(String(id)) || null,
    }));
  }

  return doc;
}

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
  const filter = {
    status: {
      $in: ['new', 'draft_ready', 'reviewed'],
    },
  };

  const safePage = Math.max(1, Number(page) || 1);

  const safeLimit = Math.max(1, Number(limit) || 25);

  const skip = (safePage - 1) * safeLimit;

  const [emails, total] = await Promise.all([
    populateAiEmail(
      AiEmail.find(filter)
        .sort({
          receivedAt: -1,
        })
        .skip(skip)
        .limit(safeLimit),
    ),

    AiEmail.countDocuments(filter),
  ]);

  return {
    emails,
    total,
    page: safePage,
    limit: safeLimit,
  };
}

async function getAllAiEmails({ page = 1, limit = 25, status = null } = {}) {
  const filter = {};

  if (status) {
    filter.status = status;
  }

  const safePage = Math.max(1, Number(page) || 1);

  const safeLimit = Math.max(1, Number(limit) || 25);

  const skip = (safePage - 1) * safeLimit;

  const [emails, total] = await Promise.all([
    populateAiEmail(
      AiEmail.find(filter)
        .sort({
          receivedAt: -1,
        })
        .skip(skip)
        .limit(safeLimit),
    ),

    AiEmail.countDocuments(filter),
  ]);

  return {
    emails,
    total,
    page: safePage,
    limit: safeLimit,
  };
}

async function getAiEmailById(id) {
  if (!id) return null;

  return populateAiEmail(AiEmail.findById(id));
}

function buildSystemPrompt(settings) {
  return `
You are the Bothell Select parent email assistant.

Your job is to analyze an incoming parent email and prepare a professional,
warm, concise draft response for a Bothell Select administrator.

IMPORTANT:
The supplied DATABASE CONTEXT is authoritative.

Never invent, assume, estimate, or use prior knowledge for:
- player registration
- payment status
- payment amount
- payment date
- tryout dates
- tryout times
- tryout locations
- tryout grade groups
- tryout fees
- registration deadlines
- payment deadlines
- what to bring

If database data is present, use it.

CURRENT TRYOUT INFORMATION:
The current tryout information comes directly from the active
TournamentConfig MongoDB document. It is the authoritative source for
the current Bothell Select tryouts.

CHILD MATCHING:

If the parent names a child:
- Match the name against the family players.
- Common nicknames such as Theo/Theodore, Alex/Alexander,
  Ariana/Ari are acceptable matches.

If the parent says "my son":
- Use male children.

If the parent says "my daughter":
- Use female children.

If multiple children match:
- Do not silently choose one.
- Include the relevant information for each child.
- Briefly explain that more than one child matches.

If exactly one child matches:
- Answer confidently.

If no child matches the gender term:
- State that an administrator will verify.
- List the children found in the account.

TRYOUT SESSION MATCHING:

Match the child's gender and grade to the current tryout session.

For example:
- Girls: grades 4th thru 8th
- Boys: grades 4th & 5th
- Boys: grades 6th, 7th, & 8th

If a matching session has been supplied in DATABASE CONTEXT,
use its date, time, venue and address directly.

When answering "when/where is the tryout?", include:
- date
- start time
- end time
- venue
- street address
- city/state/ZIP when available

REGISTRATION:

To answer whether a child is registered:
- Check the current-season registration data.
- registrationComplete must be true to confidently confirm registration.

PAYMENTS:

To answer whether a child paid:
- Check paymentComplete/paymentStatus.
- When confirming a payment, include amountPaid and paymentDate
  when available.
- Include cardLast4/cardBrand when available.
- Never expose complete card numbers.

MULTIPLE PAYMENTS:

If multiple payments exist for a child:
- List them separately.
- Never combine multiple payment IDs into one value.

NO PARENT:

If no parent record was found:
- Do not claim the parent is registered.
- Say an administrator will verify.
- Confidence must be 20 or lower.

IMPORTANT CONFIDENCE RULE:

Confidence reflects the quality and completeness of the actual database
information available to answer the question.

If the parent and relevant child/database information clearly answers the
question, confidence should normally be 90-100.

If information is ambiguous or incomplete, reduce confidence.

Never lower confidence merely because a child had to be resolved from
"my son" or "my daughter" when the database clearly identifies the child.

DO NOT:
- invent facts
- mention internal MongoDB IDs
- expose passwords
- approve refunds
- make roster/team placement decisions
- promise something that the database does not establish
- tell the parent to "refer to the latest communication" when the supplied
  current tryout data directly answers their question
- say "according to our records" when the information is unambiguous
  and directly confirms the answer

STYLE:

Be warm, concise and professional.

The response should sound like a helpful Bothell Select administrator.

Sign the response exactly:

Bothell Select Basketball

Return ONLY valid JSON.

Required JSON format:

{
  "category": "one of: ${ALLOWED_CATEGORIES.join(', ')}",
  "confidence": 0,
  "draft": "draft response",
  "reason": "short explanation",
  "dataUsed": [],
  "requiresHumanReview": true,
  "reviewReason": "why human review is required"
}

Confidence must be an integer from 0 to 100.

Settings:
tone=${settings.tone}
confidenceThreshold=${settings.confidenceThreshold}
automaticRepliesEnabled=${settings.automaticRepliesEnabled}
`.trim();
}

function extractJsonFromText(rawOutput) {
  if (!rawOutput) {
    throw new Error('Empty AI output');
  }

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

async function generateAiDraft({ from, subject = '', body }) {
  if (!from) {
    throw new Error('from is required');
  }

  if (!body) {
    throw new Error('body is required');
  }

  const settings = await getAiSettings();

  // ─────────────────────────────────────────────────────────────
  // STEP 1 — ALWAYS resolve parent directly in MongoDB
  // ─────────────────────────────────────────────────────────────

  const parent = await getParentByEmail(from);

  console.log(
    '[AI] Parent lookup:',
    parent ? `${parent.fullName} (${parent.email})` : 'NOT FOUND',
  );

  // ─────────────────────────────────────────────────────────────
  // STEP 2 — ALWAYS load family data when parent exists
  // ─────────────────────────────────────────────────────────────

  let family = null;

  if (parent) {
    family = await getFamilyData(parent.id);

    console.log('[AI] Family loaded:', {
      parentFound: family.parentFound,
      players: family.players?.length || 0,
      registrations: family.registrations?.length || 0,
      payments: family.payments?.length || 0,
    });
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 3 — Load current tryout directly from MongoDB
  // whenever relevant
  // ─────────────────────────────────────────────────────────────

  let tryout = null;

  if (isTryoutQuestion(subject, body)) {
    tryout = await getCurrentTryout();

    console.log(
      '[AI] Tryout loaded:',
      tryout
        ? {
            year: tryout.tryoutYear,
            name: tryout.tryoutName,
            sessions: tryout.sessions.length,
          }
        : 'NOT FOUND',
    );
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 4 — Resolve relevant children ourselves
  // ─────────────────────────────────────────────────────────────

  let resolvedFamily = family;

  let playerResolution = null;

  if (family?.players) {
    playerResolution = resolveRelevantPlayers(subject, body, family.players);

    console.log('[AI] Player resolution:', {
      reason: playerResolution.reason,
      ambiguous: playerResolution.ambiguous,
      players: playerResolution.players.map((p) => ({
        name: p.fullName,
        gender: p.gender,
        grade: p.grade,
      })),
    });

    if (tryout) {
      resolvedFamily = attachTryoutSessionsToPlayers(family, tryout);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // STEP 5 — Build deterministic database context
  // ─────────────────────────────────────────────────────────────

  const databaseContext = {
    parent: parent || null,

    family: resolvedFamily || {
      parentFound: false,
      parent: null,
      players: [],
      registrations: [],
      payments: [],
    },

    relevantPlayers: playerResolution?.players || [],

    playerResolution: playerResolution
      ? {
          reason: playerResolution.reason,
          ambiguous: playerResolution.ambiguous,
        }
      : null,

    currentTryout: tryout || null,
  };

  console.log('[AI] DATABASE CONTEXT SUMMARY:', {
    parentFound: !!parent,
    players: databaseContext.family.players?.length || 0,
    relevantPlayers: databaseContext.relevantPlayers?.length || 0,
    registrations: databaseContext.family.registrations?.length || 0,
    payments: databaseContext.family.payments?.length || 0,
    tryoutLoaded: !!databaseContext.currentTryout,
    tryoutSessions: databaseContext.currentTryout?.sessions?.length || 0,
  });

  // ─────────────────────────────────────────────────────────────
  // STEP 6 — Give the actual DB data directly to OpenAI
  // ─────────────────────────────────────────────────────────────

  const systemPrompt = buildSystemPrompt(settings);

  const userMessage = `
INCOMING EMAIL

From:
${from}

Subject:
${subject}

Message:
${body}


DATABASE CONTEXT

${JSON.stringify(databaseContext, null, 2)}


IMPORTANT:

The DATABASE CONTEXT above was retrieved directly by the server from
MongoDB immediately before this AI request.

Treat it as authoritative.

Do not use external knowledge or assumptions to replace database values.

If the parent asks about the current tryout, use currentTryout.sessions.

If the parent asks about their child, use relevantPlayers first, then the
full family data if needed.

If relevantPlayers contains exactly one matching child, use that child.

If relevantPlayers contains multiple matching children, acknowledge the
ambiguity and provide the relevant information for each.

Generate the requested JSON response now.
`.trim();

  const messages = [
    {
      role: 'system',
      content: systemPrompt,
    },
    {
      role: 'user',
      content: userMessage,
    },
  ];

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    messages,
    temperature: 0.2,
    max_tokens: 2500,
  });

  const choice = completion.choices && completion.choices[0];

  if (!choice) {
    throw new Error('OpenAI returned no choices');
  }

  const rawOutput = choice.message?.content || '';

  if (!rawOutput) {
    throw new Error('OpenAI returned an empty final message');
  }

  console.log('=== AI RAW OUTPUT ===');

  console.log(rawOutput.slice(0, 1000));

  console.log('====================');

  let result;

  try {
    result = extractJsonFromText(rawOutput);
  } catch (parseError) {
    console.error('JSON extraction failed:', parseError.message);

    throw new Error(`OpenAI returned invalid JSON: ${parseError.message}`);
  }

  // ─────────────────────────────────────────────────────────────
  // Normalize AI output
  // ─────────────────────────────────────────────────────────────

  if (!ALLOWED_CATEGORIES.includes(result.category)) {
    result.category = 'other';
  }

  result.confidence = Math.max(
    0,
    Math.min(100, Number(result.confidence) || 0),
  );

  if (!Array.isArray(result.dataUsed)) {
    result.dataUsed = [];
  }

  if (!result.draft) {
    result.draft =
      'Thank you for contacting Bothell Select. We will review your message and get back to you shortly.\n\nBothell Select Basketball';
  }

  if (!result.reason) {
    result.reason =
      'AI generated a draft using the available database context.';
  }

  if (!result.reviewReason) {
    result.reviewReason = 'Human review is required.';
  }

  // If no parent was found, confidence MUST be <= 20.
  if (!parent) {
    result.confidence = Math.min(result.confidence, 20);

    result.requiresHumanReview = true;

    result.reviewReason =
      'No matching parent record was found for this email address — verify manually.';
  }

  // If tryout information was requested but could not
  // be loaded, force human review.
  if (isTryoutQuestion(subject, body) && !tryout) {
    result.confidence = Math.min(result.confidence, 40);

    result.requiresHumanReview = true;

    result.reviewReason =
      'The current tryout database configuration could not be loaded.';
  }

  // If the email asks about registration/payment but there
  // are no family records, require review.
  if (
    parent &&
    (isRegistrationQuestion(subject, body) ||
      isPaymentQuestion(subject, body)) &&
    !family
  ) {
    result.confidence = Math.min(result.confidence, 40);

    result.requiresHumanReview = true;

    result.reviewReason = 'Family registration/payment data was not available.';
  }

  return {
    ...result,

    parent: parent || null,

    context: resolvedFamily || {
      parentFound: false,
      parent: null,
      players: [],
      registrations: [],
      payments: [],
    },

    tryout: tryout || null,

    relevantPlayers: playerResolution?.players || [],

    effectiveEmail: from,
  };
}

async function evaluateAutoSendEligibility(aiEmail) {
  const settings = await getAiSettings();

  if (!settings.enabled) {
    return {
      eligible: false,
      reason: 'AI assistant is disabled.',
    };
  }

  if (!settings.automaticRepliesEnabled) {
    return {
      eligible: false,
      reason: 'Automatic replies are disabled.',
    };
  }

  if (aiEmail.confidence < settings.confidenceThreshold) {
    return {
      eligible: false,
      reason: `Confidence ${aiEmail.confidence}% is below threshold ${settings.confidenceThreshold}%.`,
    };
  }

  if (
    Array.isArray(settings.alwaysRequireHumanReview) &&
    settings.alwaysRequireHumanReview.includes(aiEmail.category)
  ) {
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

  return {
    eligible: true,
    reason: 'All auto-send conditions met.',
  };
}

async function sendAiReply(aiEmail) {
  const body = aiEmail.humanEditedDraft || aiEmail.aiDraft;

  if (!body) {
    throw new Error('No draft body available to send.');
  }

  const headers = {};

  if (aiEmail.messageId) {
    headers['In-Reply-To'] = aiEmail.messageId;

    headers.References = aiEmail.messageId;
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

  if (error) {
    throw new Error(error.message || 'Resend send failed');
  }

  return data?.id || null;
}

async function processIncomingEmail(emailData) {
  const normalizedFrom = extractEmailAddress(emailData.from);

  let resolvedEmailData = emailData;

  // Some inbound providers may show our own mailbox
  // as the sender while the actual parent email is
  // contained in the message body.
  if (SITE_OWNED_EMAILS.has(normalizedFrom)) {
    const bodyEmail = extractEmailFromBody(emailData.body);

    if (bodyEmail && !SITE_OWNED_EMAILS.has(bodyEmail)) {
      console.log(
        `"from" was site-owned ("${normalizedFrom}"); replacing with body email "${bodyEmail}".`,
      );

      resolvedEmailData = {
        ...emailData,
        from: bodyEmail,
      };
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

  // ─────────────────────────────────────────────────────────────
  // Filter
  // ─────────────────────────────────────────────────────────────

  const filterResult = await shouldProcessEmail(resolvedEmailData.from);

  if (!filterResult.process) {
    console.log(`Skipping email — ${filterResult.reason}`);

    try {
      const skipped = await AiEmail.create({
        messageId: emailData.messageId,

        threadId: emailData.threadId || null,

        from: resolvedEmailData.from,

        to: resolvedEmailData.to || null,

        subject: resolvedEmailData.subject || '',

        body: resolvedEmailData.body,

        receivedAt: emailData.receivedAt || new Date(),

        status: 'skipped',

        skipReason: filterResult.reason,

        requiresHumanReview: false,

        reviewReason: filterResult.reason,
      });

      return skipped;
    } catch (saveErr) {
      if (saveErr.code === 11000) {
        console.log('Skipped email already recorded.');

        return null;
      }

      throw saveErr;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Create AI email
  // ─────────────────────────────────────────────────────────────

  const aiEmail = await createAiEmail(resolvedEmailData);

  console.log('Created AiEmail:', aiEmail._id.toString());

  try {
    console.log('Generating AI draft using direct MongoDB context...');

    const result = await generateAiDraft({
      from: resolvedEmailData.from,

      subject: resolvedEmailData.subject || '',

      body: resolvedEmailData.body,
    });

    console.log('AI result summary:', {
      category: result.category,

      confidence: result.confidence,

      hasParent: !!result.parent,

      playerCount: result.context?.players?.length || 0,

      relevantPlayers: result.relevantPlayers?.length || 0,

      hasTryout: !!result.tryout,

      tryoutSessions: result.tryout?.sessions?.length || 0,
    });

    aiEmail.category = result.category;

    aiEmail.confidence = result.confidence;

    aiEmail.aiDraft = result.draft;

    aiEmail.aiReason = result.reason;

    aiEmail.dataUsed = result.dataUsed;

    aiEmail.replyToEmail = result.effectiveEmail || resolvedEmailData.from;

    // Parent ID
    if (result.parent) {
      const pid = result.parent.id || result.parent._id || null;

      if (pid && mongoose.Types.ObjectId.isValid(pid)) {
        aiEmail.parentId = pid;
      }
    }

    // Player IDs
    if (result.context?.players) {
      aiEmail.playerIds = normalizeIdList(
        result.context.players.map((player) => player.id),
      );
    }

    // REAL registration IDs
    if (result.context?.registrations) {
      aiEmail.registrationIds = normalizeIdList(
        result.context.registrations
          .map((registration) => registration.registrationId)
          .filter(Boolean),
      );
    }

    // Payment IDs
    if (result.context?.payments) {
      aiEmail.paymentIds = normalizeIdList(
        result.context.payments
          .map((payment) => payment.paymentId)
          .filter(Boolean),
      );
    }

    // ─────────────────────────────────────────────────────────
    // Auto send
    // ─────────────────────────────────────────────────────────

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

    console.log('AiEmail saved:', aiEmail.status);

    return aiEmail;
  } catch (error) {
    console.error('=== AI PROCESSING FAILED ===');

    console.error(error.message);

    console.error(error.stack);

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

      console.log('Saved fallback AiEmail.');
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
  if (!aiEmail) {
    throw new Error('AI email not found');
  }

  if (aiEmail.status === 'sent') {
    throw new Error('Email has already been sent');
  }

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

  getCurrentTryout,
  buildParentContext,

  generateAiDraft,
  processIncomingEmail,

  shouldProcessEmail,

  evaluateAutoSendEligibility,
  sendAiReply,
  manualSendAiEmail,

  extractJsonFromText,
  extractEmailAddress,
  extractEmailFromBody,

  normalizeIdList,

  isTryoutQuestion,
  isRegistrationQuestion,
  isPaymentQuestion,

  resolveRelevantPlayers,
  sessionMatchesPlayer,
};
