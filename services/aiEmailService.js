/**
 * aiEmailService.js
 * Bothell Select AI Parent Email Assistant
 */

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
const EventConfig = require('../models/EventConfig');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const CURRENT_TRYOUT_YEAR = Number(process.env.CURRENT_TRYOUT_YEAR) || 2026;
const CURRENT_TRYOUT_ID = process.env.CURRENT_TRYOUT_ID || '';
const VERIFIED_SENDER =
  process.env.VERIFIED_SENDER || 'Bothell Select Basketball';
const VERIFIED_SENDER_EMAIL =
  process.env.VERIFIED_SENDER_EMAIL || 'bothellselect@proton.me';

const AI_ALLOWED_DOMAINS = process.env.AI_ALLOWED_DOMAINS
  ? process.env.AI_ALLOWED_DOMAINS.split(',')
      .map((x) => x.trim().toLowerCase())
      .filter(Boolean)
  : [];

function log(...args) {
  console.log('[AI EMAIL]', ...args);
}
function logError(...args) {
  console.error('[AI EMAIL ERROR]', ...args);
}

function normalizeEmail(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}

function normalizeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString();
}

function uniqueIds(values = []) {
  return [...new Set(values.filter(Boolean).map((value) => String(value)))];
}

function normalizeIdList(values = []) {
  return uniqueIds(Array.isArray(values) ? values : [values]);
}

function extractEmailAddress(value) {
  if (!value) return null;
  const text = String(value);
  const match = text.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/);
  if (match) return normalizeEmail(match[1]);
  const plain = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return plain ? normalizeEmail(plain[0]) : null;
}

function extractEmailFromBody(body) {
  if (!body) return null;
  return extractEmailAddress(body);
}

function getMongoState() {
  return {
    readyState: mongoose.connection?.readyState,
    ready: mongoose.connection?.readyState === 1,
    database: mongoose.connection?.name || null,
    host: mongoose.connection?.host || null,
  };
}

function assertMongoConnected() {
  const state = getMongoState();
  if (!state.ready)
    throw new Error(`MongoDB is not connected. readyState=${state.readyState}`);
  return state;
}

async function getAiSettings() {
  let settings = await AiSettings.findOne({}).lean();
  if (!settings) {
    settings = {
      enabled: true,
      autoSend: false,
      requireApproval: true,
      minimumConfidence: 0.85,
    };
  }
  return settings;
}

async function updateAiSettings(updates = {}) {
  return AiSettings.findOneAndUpdate(
    {},
    { $set: updates },
    { new: true, upsert: true },
  ).lean();
}

async function findParent(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return Parent.findOne({
    $or: [
      { email: normalized },
      { emailAddress: normalized },
      { contactEmail: normalized },
    ],
  }).lean();
}

async function findParentById(parentId) {
  if (!parentId) return null;
  return Parent.findById(parentId).lean();
}

async function getParentByEmail(email) {
  return findParent(email);
}

async function findPlayersByParent(parentId) {
  if (!parentId) return [];
  const players = await Player.find({
    $or: [{ parentId }, { parents: parentId }, { parentIds: parentId }],
  }).lean();
  if (players.length > 0) return players;
  const parent = await findParentById(parentId);
  if (!parent) return [];
  const parentPlayerIds = [
    ...(Array.isArray(parent.players) ? parent.players : []),
    ...(Array.isArray(parent.playerIds) ? parent.playerIds : []),
  ];
  if (parentPlayerIds.length === 0) return [];
  return Player.find({ _id: { $in: parentPlayerIds } }).lean();
}

async function findPlayer(playerId) {
  if (!playerId) return null;
  return Player.findById(playerId).lean();
}

async function findRegistrationsByPlayer(playerId) {
  if (!playerId) return [];
  return PlayerRegistration.find({
    $or: [{ playerId }, { playerIds: playerId }],
  }).lean();
}

async function findRegistrationsByParent(parentId) {
  if (!parentId) return [];
  const players = await findPlayersByParent(parentId);
  if (players.length === 0) return [];
  const playerIds = players.map((player) => player._id).filter(Boolean);
  return PlayerRegistration.find({
    $or: [
      { playerId: { $in: playerIds } },
      { playerIds: { $in: playerIds } },
      { parentId },
    ],
  }).lean();
}

async function findPaymentsByParent(parentId) {
  if (!parentId) return [];
  return Payment.find({ $or: [{ parentId }, { parentIds: parentId }] }).lean();
}

async function findPaymentsByPlayer(playerId) {
  if (!playerId) return [];
  return Payment.find({ $or: [{ playerId }, { playerIds: playerId }] }).lean();
}

async function findPaymentsByTeam(teamId) {
  if (!teamId) return [];
  return Payment.find({ $or: [{ teamId }, { teamIds: teamId }] }).lean();
}

async function findTeam(teamId) {
  if (!teamId) return null;
  return Team.findById(teamId).lean();
}

async function findTeamsByCoach(coachId) {
  if (!coachId) return [];
  return Team.find({ $or: [{ coachId }, { coaches: coachId }] }).lean();
}

async function getTournamentConfig() {
  assertMongoConnected();
  const collection = TournamentConfig.collection;
  let config = null;

  if (CURRENT_TRYOUT_ID) {
    config = await collection.findOne({
      isActive: true,
      $or: [{ eventId: CURRENT_TRYOUT_ID }, { tryoutId: CURRENT_TRYOUT_ID }],
    });
  }
  if (!config) {
    config = await collection.findOne({
      tryoutYear: CURRENT_TRYOUT_YEAR,
      isActive: true,
    });
  }
  if (!config) {
    config = await collection.findOne(
      { isActive: true, eventId: { $exists: true } },
      { sort: { tryoutYear: -1, updatedAt: -1, createdAt: -1 } },
    );
  }
  return config;
}

async function getEventConfig() {
  assertMongoConnected();
  const collection = EventConfig.collection;
  return collection.findOne(
    { eventType: 'tryout', isActive: true },
    { sort: { startDate: -1, updatedAt: -1, createdAt: -1 } },
  );
}

function normalizeLocation(location) {
  if (!location) return null;
  return {
    name: location.name || location.venue || null,
    address: location.address || null,
    city: location.city || null,
    state: location.state || null,
    zip: location.zip || location.postalCode || null,
  };
}

function normalizeSession(session = {}) {
  return {
    number: session.number ?? null,
    date: session.date || null,
    startTime: normalizeString(session.startTime) || null,
    endTime: normalizeString(session.endTime) || null,
    grades: session.grades || null,
    gender: session.gender || null,
    location: normalizeLocation(session.location),
  };
}

async function getCurrentTryout() {
  const [tournamentConfig, eventConfig] = await Promise.all([
    getTournamentConfig(),
    getEventConfig(),
  ]);

  log('Tryout lookup:', {
    tournamentConfigFound: !!tournamentConfig,
    eventConfigFound: !!eventConfig,
    tournamentYear: tournamentConfig?.tryoutYear,
    eventTitle: eventConfig?.title,
  });

  const tournamentDetails = tournamentConfig?.tryoutDetails || {};
  const rawSessions = Array.isArray(tournamentDetails.tryoutSessions)
    ? tournamentDetails.tryoutSessions
    : [];
  const sessions = rawSessions.map(normalizeSession);
  const eventLocation = normalizeLocation(eventConfig?.location);
  const firstSessionLocation =
    sessions.find((s) => s.location)?.location || null;
  const location = firstSessionLocation || eventLocation || null;
  const hasDetailedSessions = sessions.length > 0;

  return {
    exists: !!tournamentConfig || !!eventConfig,
    source: hasDetailedSessions
      ? 'TournamentConfig'
      : eventConfig
        ? 'eventconfigs'
        : tournamentConfig
          ? 'TournamentConfig'
          : null,
    year: tournamentConfig?.tryoutYear || CURRENT_TRYOUT_YEAR,
    title:
      tournamentConfig?.displayName ||
      tournamentConfig?.tryoutName ||
      eventConfig?.title ||
      'Bothell Select Tryouts',
    eventId: tournamentConfig?.eventId || null,
    date: tournamentDetails.startDate || eventConfig?.startDate || null,
    gender: tournamentDetails.gender || eventConfig?.gender || null,
    grades: eventConfig?.grades || null,
    fee: tournamentConfig?.tryoutFee ?? eventConfig?.price ?? null,
    registrationOpen: eventConfig?.registrationOpen ?? true,
    registrationDeadline: tournamentConfig?.registrationDeadline || null,
    paymentDeadline: tournamentConfig?.paymentDeadline || null,
    refundPolicy: tournamentConfig?.refundPolicy || null,
    dropOffTime: tournamentDetails.dropOffTime || null,
    whatToBring:
      tournamentDetails.whatToBring || eventConfig?.whatToBring || [],
    whatToExpect: eventConfig?.whatToExpect || null,
    hasLimitedSpots: tournamentConfig?.hasLimitedSpots ?? false,
    contactEmail: tournamentConfig?.contactEmail || null,
    location,
    sessions,
    generalEventWindow: {
      startTime: eventConfig?.startTime || null,
      endTime: eventConfig?.endTime || null,
    },
  };
}

async function buildParentContext(parent) {
  if (!parent?._id)
    return { parent: null, players: [], registrations: [], payments: [] };

  const parentId = parent._id;
  const players = await findPlayersByParent(parentId);
  const registrations = await findRegistrationsByParent(parentId);
  const parentPayments = await findPaymentsByParent(parentId);

  const playerPaymentArrays = await Promise.all(
    players.map((player) => findPaymentsByPlayer(player._id)),
  );
  const playerPayments = playerPaymentArrays.flat();

  const paymentMap = new Map();
  [...parentPayments, ...playerPayments].forEach((payment) => {
    if (!payment) return;
    const id = payment._id ? String(payment._id) : JSON.stringify(payment);
    if (!paymentMap.has(id)) paymentMap.set(id, payment);
  });

  return { parent, players, registrations, payments: [...paymentMap.values()] };
}

function buildAiSafeParent(parent) {
  if (!parent) return null;
  return {
    firstName: parent.firstName || parent.firstname || null,
    lastName: parent.lastName || parent.lastname || null,
    fullName:
      parent.fullName ||
      [parent.firstName, parent.lastName].filter(Boolean).join(' ') ||
      null,
    email: parent.email || parent.emailAddress || parent.contactEmail || null,
    phone: parent.phone || parent.phoneNumber || null,
  };
}

function buildAiSafePlayer(player) {
  if (!player) return null;
  return {
    firstName: player.firstName || player.firstname || null,
    lastName: player.lastName || player.lastname || null,
    fullName:
      player.fullName ||
      [player.firstName, player.lastName].filter(Boolean).join(' ') ||
      null,
    gender: player.gender || null,
    grade: player.grade || player.currentGrade || player.schoolGrade || null,
    birthDate: safeDate(player.birthDate || player.dateOfBirth),
    status: player.status || null,
  };
}

function buildAiSafeRegistration(registration) {
  if (!registration) return null;
  return {
    playerId: registration.playerId ? String(registration.playerId) : null,
    status: registration.status || registration.registrationStatus || null,
    registered: registration.registered ?? registration.isRegistered ?? null,
    eventId: registration.eventId || null,
    eventName: registration.eventName || registration.seasonName || null,
    season: registration.season || null,
    registrationDate: safeDate(
      registration.registrationDate || registration.createdAt,
    ),
    paymentStatus: registration.paymentStatus || null,
    amount: registration.amount ?? registration.price ?? null,
  };
}

function buildAiSafePayment(payment) {
  if (!payment) return null;
  return {
    status: payment.status || payment.paymentStatus || null,
    amount: payment.amount ?? payment.total ?? payment.amountPaid ?? null,
    currency: payment.currency || 'USD',
    paymentDate: safeDate(
      payment.paymentDate || payment.paidAt || payment.createdAt,
    ),
    playerId: payment.playerId ? String(payment.playerId) : null,
    paymentId: payment.paymentId || payment.squarePaymentId || null,
    receiptUrl: payment.receiptUrl || null,
    description: payment.description || payment.memo || null,
  };
}

async function buildLiveDatabaseContext({ senderEmail, subject, body }) {
  assertMongoConnected();
  const normalizedSender = normalizeEmail(senderEmail);
  log('Building LIVE MongoDB context for:', normalizedSender);

  const parent = await findParent(normalizedSender);
  log('Parent found:', !!parent);

  let family = { parent: null, players: [], registrations: [], payments: [] };
  if (parent) family = await buildParentContext(parent);

  const tryout = await getCurrentTryout();

  const context = {
    request: {
      senderEmail: normalizedSender,
      subject: subject || '',
      body: body || '',
    },
    parent: buildAiSafeParent(family.parent),
    players: family.players.map(buildAiSafePlayer),
    registrations: family.registrations.map(buildAiSafeRegistration),
    payments: family.payments.map(buildAiSafePayment),
    currentTryout: tryout,
  };

  return { raw: family, tryout, aiContext: context };
}

function buildSystemPrompt(liveContext) {
  return `
You are the Bothell Select Basketball parent email assistant.

Your job is to answer parent emails accurately, warmly, and concisely.

========================================================
CRITICAL DATABASE RULE
========================================================

The information below was retrieved DIRECTLY by the server
from the Bothell Select MongoDB database immediately before
this request.

It is VERIFIED DATABASE DATA.

You must use this data as the source of truth.

NEVER claim that information is unavailable if it exists
anywhere in this database context.

NEVER invent information.

NEVER guess.

If information is not present, say that it is not available
in the information provided and avoid making up an answer.

========================================================
TRYOUT DATA PRIORITY
========================================================

There may be two MongoDB sources:

1. TournamentConfig
2. eventconfigs

TournamentConfig takes precedence when it contains detailed
tryout sessions.

The detailed sessions are more authoritative than the general
event startTime/endTime.

========================================================
PARENT / PLAYER RULES
========================================================

If the sender is a known parent:

- Use the parent information provided.
- Use the player's information provided.
- If the parent says "my son", "my daughter", or "my child",
  identify the matching player when possible.
- If only one child matches, use that child.
- If multiple children could match and you cannot determine
  which one they mean, do not guess.

If registration data says the player is registered, clearly
tell the parent they are registered.

If payment data confirms payment, clearly tell the parent
payment was received.

Do not tell a parent to register again if the database shows
that they are already registered.

Do not tell a parent to pay again if the database shows that
payment has already been received.

========================================================
BUSINESS RULES
========================================================

You may provide factual information about:

- Tryout date
- Tryout time
- Grade-specific session
- Gender-specific session
- Location
- Address
- Fee
- Registration deadline
- Payment deadline
- What to bring
- What to expect
- Registration status
- Payment status
- Player information
- Team information if provided

Do NOT:

- promise team placement
- make roster decisions
- approve refunds
- invent exceptions
- promise playing time
- make eligibility decisions that are not in the database

========================================================
EMAIL STYLE
========================================================

Be warm and professional.

Keep responses reasonably concise.

Use the parent's name when available.

When answering a schedule question, make the date/time/location
easy to read.

Always end with:

Best regards,

Bothell Select Basketball

========================================================
LIVE DATABASE CONTEXT
========================================================

${JSON.stringify(liveContext, null, 2)}
`;
}

function extractJsonFromText(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (codeBlock) {
    try {
      return JSON.parse(codeBlock[1]);
    } catch {}
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

async function generateAiDraft({ from, subject, body, liveContext }) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('OPENAI_API_KEY is not configured');

  let contextPackage = liveContext;
  if (!contextPackage) {
    contextPackage = await buildLiveDatabaseContext({
      senderEmail: from,
      subject,
      body,
    });
  }

  const systemPrompt = buildSystemPrompt(contextPackage.aiContext);
  const userPrompt = `
Write a reply to this parent email.

Return ONLY valid JSON with exactly these fields:

{
  "subject": "string",
  "body": "string",
  "confidence": 0.0,
  "requiresHumanReview": true,
  "reason": "string"
}

Parent email:

From: ${from || ''}
Subject: ${subject || ''}

${body || ''}
`;

  const completion = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const content = completion.choices?.[0]?.message?.content || '';
  let result = extractJsonFromText(content);

  if (!result) {
    result = {
      subject: subject
        ? `Re: ${subject.replace(/^re:\s*/i, '')}`
        : 'Bothell Select Basketball',
      body:
        content ||
        'Thank you for contacting Bothell Select Basketball. We will review your message and get back to you.',
      confidence: 0,
      requiresHumanReview: true,
      reason: 'AI response was not returned in the expected JSON format.',
    };
  }

  const draft = {
    subject:
      result.subject ||
      (subject
        ? `Re: ${subject.replace(/^re:\s*/i, '')}`
        : 'Bothell Select Basketball'),
    body: result.body || '',
    confidence: Number(result.confidence) || 0,
    requiresHumanReview: result.requiresHumanReview !== false,
    reason: result.reason || '',
  };

  if (draft.confidence < 0.85) draft.requiresHumanReview = true;

  return {
    ...draft,
    // ✅ Raw object — NOT JSON.stringify — schema is Mixed
    dataUsed: {
      parentFound: !!contextPackage.raw.parent,
      playerCount: contextPackage.raw.players?.length || 0,
      registrationCount: contextPackage.raw.registrations?.length || 0,
      paymentCount: contextPackage.raw.payments?.length || 0,
      tryoutFound: !!contextPackage.tryout?.exists,
      tryoutSource: contextPackage.tryout?.source || null,
    },
    liveContext: contextPackage,
  };
}

async function createAiEmail({ from, subject, body, messageId = null }) {
  const normalizedFrom = normalizeEmail(from);

  if (messageId) {
    const existing = await AiEmail.findOne({
      $or: [{ messageId }, { originalMessageId: messageId }],
    }).lean();
    if (existing) {
      log('Email already processed:', messageId);
      return existing;
    }
  }

  const liveContext = await buildLiveDatabaseContext({
    senderEmail: normalizedFrom,
    subject,
    body,
  });

  const draft = await generateAiDraft({
    from: normalizedFrom,
    subject,
    body,
    liveContext,
  });

  const parentId = liveContext.raw.parent?._id || null;
  const playerIds = liveContext.raw.players.map((p) => p._id).filter(Boolean);
  const registrationIds = liveContext.raw.registrations
    .map((r) => r._id)
    .filter(Boolean);
  const paymentIds = liveContext.raw.payments.map((p) => p._id).filter(Boolean);

  // ✅ Field names now match the schema exactly
  const aiEmail = await AiEmail.create({
    messageId,
    originalMessageId: messageId,
    from: normalizedFrom,
    to: VERIFIED_SENDER_EMAIL,
    subject,
    body: body, // was: originalBody
    receivedAt: new Date(),
    parentId,
    playerIds,
    registrationIds,
    paymentIds,
    aiDraft: draft.body, // was: aiBody
    aiReason: draft.reason,
    confidence: draft.confidence,
    requiresHumanReview: draft.requiresHumanReview,
    status: 'new',
    dataUsed: draft.dataUsed,
  });

  log('AiEmail persisted:', aiEmail._id.toString());
  return aiEmail;
}

async function getPendingAiEmails() {
  return AiEmail.find({
    status: { $in: ['new', 'pending', 'review', 'draft_ready'] },
  })
    .sort({ createdAt: -1 })
    .lean();
}

async function getAllAiEmails(options = {}) {
  const limit = Number(options.limit) || 100;
  return AiEmail.find({}).sort({ createdAt: -1 }).limit(limit).lean();
}

async function getAiEmailById(id) {
  if (!id) return null;
  return AiEmail.findById(id).lean();
}

async function processIncomingEmail({
  from,
  to,
  subject,
  body,
  messageId = null,
}) {
  const normalizedFrom = normalizeEmail(from);

  log('Processing incoming email:', {
    from: normalizedFrom,
    subject,
    messageId,
  });

  const processCheck = await shouldProcessEmail(normalizedFrom);
  if (!processCheck.process) {
    log('Email ignored:', processCheck.reason);
    return { processed: false, reason: processCheck.reason };
  }

  if (messageId) {
    const existing = await AiEmail.findOne({
      $or: [{ messageId }, { originalMessageId: messageId }],
    }).lean();
    if (existing) return { processed: false, duplicate: true, email: existing };
  }

  const aiEmail = await createAiEmail({
    from: normalizedFrom,
    subject,
    body,
    messageId,
  });

  const autoSendCheck = await evaluateAutoSendEligibility(aiEmail);
  if (autoSendCheck.allowed) {
    try {
      await sendAiReply(aiEmail);
      return { processed: true, autoSent: true, email: aiEmail };
    } catch (error) {
      logError('Auto-send failed:', error);
      return {
        processed: true,
        autoSent: false,
        sendError: error.message,
        email: aiEmail,
      };
    }
  }

  return {
    processed: true,
    autoSent: false,
    requiresReview: true,
    autoSendReason: autoSendCheck.reason,
    email: aiEmail,
  };
}

async function shouldProcessEmail(email) {
  const normalized = normalizeEmail(email);

  if (!normalized)
    return { process: false, reason: 'No sender email address.' };

  if (normalized === normalizeEmail(VERIFIED_SENDER_EMAIL)) {
    return { process: false, reason: 'Email originated from Bothell Select.' };
  }

  const parent = await findParent(normalized);
  if (parent) return { process: true, reason: 'Known Bothell Select parent.' };

  if (AI_ALLOWED_DOMAINS.length) {
    const domain = normalized.split('@')[1];
    if (domain && AI_ALLOWED_DOMAINS.includes(domain)) {
      return { process: true, reason: 'Sender belongs to an allowed domain.' };
    }
  }

  return {
    process: false,
    reason: 'Sender is not a recognized parent or allowed sender.',
  };
}

async function evaluateAutoSendEligibility(aiEmail) {
  const settings = await getAiSettings();

  if (!settings.enabled)
    return { allowed: false, reason: 'AI assistant is disabled.' };
  if (!settings.autoSend)
    return { allowed: false, reason: 'Auto-send is disabled.' };
  if (settings.requireApproval)
    return { allowed: false, reason: 'Human approval is required.' };

  const minimumConfidence = Number(settings.minimumConfidence) || 0.85;

  if (Number(aiEmail.confidence) < minimumConfidence) {
    return {
      allowed: false,
      reason: `AI confidence ${aiEmail.confidence} is below minimum ${minimumConfidence}.`,
    };
  }
  if (aiEmail.requiresHumanReview) {
    return {
      allowed: false,
      reason: 'AI marked this response for human review.',
    };
  }
  if (!aiEmail.aiDraft)
    return { allowed: false, reason: 'AI response body is empty.' };

  return { allowed: true, reason: 'Passed auto-send requirements.' };
}

async function sendAiReply(aiEmail) {
  if (!aiEmail) throw new Error('AI email record is required.');
  if (!aiEmail.aiDraft) throw new Error('AI email body is empty.');
  if (!resend) throw new Error('RESEND_API_KEY is not configured.');

  const recipient = normalizeEmail(aiEmail.replyToEmail || aiEmail.from);
  if (!recipient) throw new Error('Recipient email address is missing.');

  const response = await resend.emails.send({
    from: VERIFIED_SENDER_EMAIL,
    to: recipient,
    subject: `Re: ${aiEmail.subject || 'Bothell Select Basketball'}`,
    text: aiEmail.aiDraft, // ✅ uses aiDraft
    headers: aiEmail.messageId
      ? { 'In-Reply-To': aiEmail.messageId, References: aiEmail.messageId }
      : undefined,
  });

  await AiEmail.findByIdAndUpdate(aiEmail._id, {
    $set: {
      status: 'sent',
      sentAt: new Date(),
      resendId: response?.data?.id || null,
    },
  });

  return response;
}

async function manualSendAiEmail(aiEmailId, options = {}) {
  const aiEmail = await AiEmail.findById(aiEmailId);
  if (!aiEmail) throw new Error('AI email not found.');
  if (options.draft) aiEmail.aiDraft = options.draft;
  if (options.reviewedBy) aiEmail.reviewedBy = options.reviewedBy;
  await aiEmail.save();
  return sendAiReply(aiEmail);
}

async function debugCurrentTryout() {
  const state = assertMongoConnected();
  const tryout = await getCurrentTryout();
  return { mongo: state, tryout };
}

module.exports = {
  getAiSettings,
  updateAiSettings,
  findParent,
  findParentById,
  getParentByEmail,
  findPlayersByParent,
  findPlayer,
  findRegistrationsByPlayer,
  findRegistrationsByParent,
  findPaymentsByParent,
  findPaymentsByPlayer,
  findPaymentsByTeam,
  findTeam,
  findTeamsByCoach,
  getTournamentConfig,
  getEventConfig,
  getCurrentTryout,
  buildParentContext,
  buildLiveDatabaseContext,
  generateAiDraft,
  createAiEmail,
  processIncomingEmail,
  shouldProcessEmail,
  evaluateAutoSendEligibility,
  sendAiReply,
  manualSendAiEmail,
  getPendingAiEmails,
  getAllAiEmails,
  getAiEmailById,
  extractJsonFromText,
  extractEmailAddress,
  extractEmailFromBody,
  normalizeIdList,
  debugCurrentTryout,
};
