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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const resend = new Resend(process.env.RESEND_API_KEY);

const VERIFIED_SENDER = 'Bothell Select <info@bothellselect.com>';

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

// ─────────────────────────────────────────────────────────────────────────────
// Email address normalization
// ─────────────────────────────────────────────────────────────────────────────

// Inbound "from" headers often look like `"Davorin Savovic" <davorins@gmail.com>`.
// Parent lookups need the bare address, or findParent() silently returns null
// and the AI ends up with parentFound: false while still rating its own
// classification confidence high.
function extractEmailAddress(rawFrom) {
  if (!rawFrom) return '';
  const match = String(rawFrom).match(/<([^>]+)>/);
  const address = match ? match[1] : rawFrom;
  return address.toLowerCase().trim();
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

async function findPlayersByParent(parentId) {
  if (!parentId) return [];
  return Player.find({ parentId });
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

async function getPendingAiEmails() {
  return AiEmail.find({
    status: { $in: ['new', 'draft_ready', 'reviewed'] },
  }).sort({ receivedAt: -1 });
}

async function getAllAiEmails({ limit = 100, status = null } = {}) {
  const filter = {};
  if (status) filter.status = status;
  return AiEmail.find(filter).sort({ receivedAt: -1 }).limit(limit);
}

async function getAiEmailById(id) {
  if (!id) return null;
  return AiEmail.findById(id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Context building
// ─────────────────────────────────────────────────────────────────────────────

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

  // Flatten every player's `seasons` array into a single registrations list
  const registrationsFromSeasons = players.flatMap((player) =>
    (player.seasons || []).map((season) => ({
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

  // Also pull the standalone PlayerRegistration collection
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
    })),

    registrations: allRegistrations,
    payments: allPayments,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Robust JSON extraction from AI response
// ─────────────────────────────────────────────────────────────────────────────

function extractJsonFromText(rawOutput) {
  if (!rawOutput) {
    throw new Error('Empty AI output');
  }

  let cleaned = String(rawOutput).trim();

  // Remove BOM and normalize whitespace
  cleaned = cleaned.replace(/^\uFEFF/, '');

  // Strip ```json ... ``` or ``` ... ``` fences
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '');
    cleaned = cleaned.replace(/\s*```\s*$/i, '');
  }

  // Trim any leading prose before the first {
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

// ─────────────────────────────────────────────────────────────────────────────
// AI draft generation
// ─────────────────────────────────────────────────────────────────────────────

async function generateAiDraft({ from, subject = '', body }) {
  if (!from) throw new Error('from is required');
  if (!body) throw new Error('body is required');

  const settings = await getAiSettings();
  const normalizedFrom = extractEmailAddress(from);
  const parent = await findParent(normalizedFrom);
  const context = await buildParentContext(parent);

  console.log('DB context:', JSON.stringify(context, null, 2));
  console.log(
    'Mongoose readyState:',
    require('mongoose').connection.readyState,
  );

  const systemPrompt = `
You are the Bothell Select parent email assistant.

Your job is to analyze an incoming email from a parent and prepare
a professional draft response for a Bothell Select administrator.

DATA YOU RECEIVE
You are given a "context" object containing verified Bothell Select data:

- context.parent: the parent's fullName, email, phone, relationship.
- context.players: each child with fullName, grade, gender,
  registrationComplete, paymentComplete, paymentStatus.
- context.registrations: each registration with playerName, season, year,
  tryoutId, registrationDate, registrationComplete, paymentComplete,
  paymentStatus, amountPaid, paymentDate, cardLast4, cardBrand.
- context.payments: each payment with playerName, amountPaid, status,
  paidAt, cardLast4, cardBrand.

IMPORTANT RULES

1. Never invent facts. Only use what is in the context.
2. Match children by context.players[*].fullName.
3. To answer "is my child registered?", check
   context.players[*].registrationComplete AND
   context.registrations[*].registrationComplete for that child.
4. To answer "did I pay?", check context.players[*].paymentComplete AND
   context.registrations[*].paymentComplete for that child. Include
   amountPaid, paymentDate, and cardLast4 when confirming.
5. If the context is missing information the parent asked about, say that
   the administrator needs to verify it — do NOT guess.
6. Do not expose passwords or internal IDs.
7. Do not make team placement decisions or approve refunds.
8. Sound like a helpful Bothell Select administrator. Be warm and concise.
9. Sign the response as "Bothell Select Basketball".

CONFIDENCE
"confidence" must reflect whether you actually had the data to answer the
parent's question — not just whether you picked the right category. If
context.parentFound is false, or the child the parent asked about is not
in context.players, confidence must be 20 or lower, regardless of how
clear the category is.

CATEGORIES

- tryouts
- registration
- payments
- schedules
- teams
- practices
- programs
- technical
- general
- other

Return ONLY valid JSON. Do NOT wrap it in markdown fences. Do NOT include
any text before or after the JSON. The response must start with { and end
with }.

JSON structure:

{
  "category": "one of the allowed categories",
  "confidence": 0,
  "draft": "draft response",
  "reason": "short explanation of category and confidence",
  "dataUsed": ["parent", "players", "registrations", "payments"],
  "requiresHumanReview": true,
  "reviewReason": "why a human should review this response"
}

Confidence must be 0-100. Higher = more certain the response is correct.
`;

  const userPrompt = `
Incoming parent email:

From: ${normalizedFrom}
Subject: ${subject}

Message:
${body}

Verified Bothell Select data (this is the only source of truth):

${JSON.stringify(context, null, 2)}

AI assistant settings:

${JSON.stringify(
  {
    tone: settings.tone,
    confidenceThreshold: settings.confidenceThreshold,
    automaticRepliesEnabled: settings.automaticRepliesEnabled,
  },
  null,
  2,
)}
`;

  const response = await openai.responses.create({
    model: 'gpt-5-mini',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_output_tokens: 2000,
    reasoning: { effort: 'low' },
  });

  if (response.status === 'incomplete') {
    const reason = response.incomplete_details?.reason || 'unknown';
    throw new Error(`OpenAI response incomplete (reason: ${reason})`);
  }

  const rawOutput = response.output_text;

  if (!rawOutput) {
    throw new Error(
      `OpenAI returned an empty response (status: ${response.status || 'unknown'})`,
    );
  }

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

  const allowedCategories = [
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

  if (!allowedCategories.includes(result.category)) {
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

  // Enforce confidence/review in code — don't rely solely on the model to
  // self-report when it actually had no data to work with. This is what
  // stops a "parent not found" case from coming back as high-confidence.
  if (!context.parentFound) {
    result.confidence = Math.min(result.confidence, 20);
    result.requiresHumanReview = true;
    result.reviewReason =
      'No matching parent record found for this email address — verify manually.';
  }

  return { ...result, parent, context };
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

  const { data, error } = await resend.emails.send({
    from: VERIFIED_SENDER,
    to: aiEmail.from,
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
  const aiEmail = await createAiEmail(emailData);

  try {
    const result = await generateAiDraft({
      from: emailData.from,
      subject: emailData.subject || '',
      body: emailData.body,
    });

    aiEmail.category = result.category;
    aiEmail.confidence = result.confidence;
    aiEmail.aiDraft = result.draft;
    aiEmail.aiReason = result.reason;
    aiEmail.dataUsed = result.dataUsed;

    if (result.parent) {
      aiEmail.parentId = result.parent._id;
    }

    if (result.context.players) {
      aiEmail.playerIds = result.context.players
        .filter((player) => player.id)
        .map((player) => player.id);
    }

    if (result.context.registrations) {
      aiEmail.registrationIds = result.context.registrations
        .filter((registration) => registration.playerId)
        .map((registration) => registration.playerId);
    }

    if (result.context.payments) {
      aiEmail.paymentIds = result.context.payments
        .filter((payment) => payment.paymentId)
        .map((payment) => payment.paymentId);
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
    return aiEmail;
  } catch (error) {
    console.error('=== AI PROCESSING FAILED ===');
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);
    console.error('============================');

    aiEmail.status = 'new';
    aiEmail.requiresHumanReview = true;
    aiEmail.reviewReason = `AI processing failed: ${error.message}`;
    aiEmail.aiDraft = `[AI draft failed: ${error.message}]`;

    await aiEmail.save();
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

  buildParentContext,
  generateAiDraft,
  processIncomingEmail,

  evaluateAutoSendEligibility,
  sendAiReply,
  manualSendAiEmail,

  extractJsonFromText,
  extractEmailAddress,
};
