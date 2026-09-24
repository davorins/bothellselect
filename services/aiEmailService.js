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

// Addresses that belong to the site itself, never to a parent. Contact-form
// submissions always arrive "from" one of these — even if one of them
// happens to also exist as a Parent record (e.g. an admin/site account),
// it must never be treated as the matched parent for an inbound email.
const SITE_OWNED_EMAILS = new Set(['info@bothellselect.com']);

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

// Contact-form submissions arrive with the envelope "from" set to the site's
// own sending address (info@bothellselect.com) — the actual parent's email
// is embedded in the body as plain text (e.g. "Email: davorins@gmail.com").
// This pulls that out as a fallback when the envelope sender doesn't match
// a parent record on its own.
function extractEmailFromBody(body) {
  if (!body) return '';

  // Prefer an explicit "Email: ..." line, which is what the contact form emits.
  const labeledMatch = String(body).match(
    /email\s*:\s*([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i,
  );
  if (labeledMatch) return labeledMatch[1].toLowerCase().trim();

  // Fall back to the first email-looking string anywhere in the body.
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
// Context building (shared by the legacy path and the AI tool-calling path)
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

// Returns the same normalized shape as buildParentContext — flattened
// seasons-based registrations/payments, `.id` keys — so the model sees
// consistent field names and the downstream linking code (playerIds,
// registrationIds, paymentIds) works whether context came from the legacy
// path or the tool-calling path.
async function getFamilyData(parentId) {
  const parent = await findParentById(parentId);
  return buildParentContext(parent);
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
// AI draft generation (tool-calling)
// ─────────────────────────────────────────────────────────────────────────────

async function generateAiDraft({ from, subject = '', body }) {
  if (!from) throw new Error('from is required');
  if (!body) throw new Error('body is required');

  const settings = await getAiSettings();

  const systemPrompt = `
You are the Bothell Select parent email assistant.

Your job is to analyze an incoming email from a parent and prepare a
professional draft response for a Bothell Select administrator.

You have access to two tools backed by the live database:
- get_parent_by_email: look up the parent account from the sender's email.
- get_family_data: given a parentId, get that family's players,
  registrations, and payments.

ALWAYS call get_parent_by_email first, using the sender's email address.
If it finds a parent, ALWAYS follow up with get_family_data using that
parent's id before answering anything about registration or payment status.

IMPORTANT RULES

1. Never invent facts. Only use what the tools return.
2. Match children by fullName within the family data.
3. To answer "is my child registered?", check that child's
   registrationComplete field (both on the player and within their
   registrations).
4. To answer "did I pay?", check paymentComplete / paymentStatus for that
   child, and include amountPaid, paymentDate, and cardLast4 when
   confirming.
5. If get_parent_by_email finds no parent, or the child the parent asked
   about isn't in the family data, say the administrator needs to verify
   it manually — do NOT guess, and set confidence to 20 or lower.
6. Do not expose passwords or internal IDs.
7. Do not make team placement decisions or approve refunds.
8. Sound like a helpful Bothell Select administrator. Be warm and concise.
9. Sign the response as "Bothell Select Basketball".

CONFIDENCE
"confidence" must reflect whether you actually had the data to answer the
parent's question — not just whether you picked the right category. If no
parent was found, or the child asked about isn't in the family data,
confidence must be 20 or lower, regardless of how clear the category is.

Once you have gathered whatever data is available (or confirmed none
exists), respond with ONLY valid JSON, no markdown fences, no text before
or after it, in exactly this shape:

{
  "category": "one of: ${ALLOWED_CATEGORIES.join(', ')}",
  "confidence": 0,
  "draft": "draft response",
  "reason": "short explanation of category and confidence",
  "dataUsed": ["parent", "players", "registrations", "payments"],
  "requiresHumanReview": true,
  "reviewReason": "why a human should review this response"
}

Confidence must be 0-100.
Settings: tone=${settings.tone}, confidenceThreshold=${settings.confidenceThreshold}, automaticRepliesEnabled=${settings.automaticRepliesEnabled}
`;

  const userPrompt = `
From: ${from}
Subject: ${subject}

Message:
${body}
`;

  let response = await openai.responses.create({
    model: 'gpt-5',
    input: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    max_output_tokens: 3000,
    reasoning: { effort: 'low' },
    tools: [
      {
        type: 'function',
        name: 'get_parent_by_email',
        description: 'Find the parent account from the sender email address.',
        parameters: {
          type: 'object',
          properties: {
            email: { type: 'string' },
          },
          required: ['email'],
        },
      },
      {
        type: 'function',
        name: 'get_family_data',
        description:
          'Get players, registrations, and payments for a parent, by parentId.',
        parameters: {
          type: 'object',
          properties: {
            parentId: { type: 'string' },
          },
          required: ['parentId'],
        },
      },
    ],
  });

  const toolContext = {};
  let iterations = 0;
  const MAX_ITERATIONS = 6;

  while (
    response.output.some((o) => o.type === 'function_call') &&
    iterations < MAX_ITERATIONS
  ) {
    iterations += 1;
    const outputs = [];

    for (const call of response.output.filter(
      (o) => o.type === 'function_call',
    )) {
      const args = JSON.parse(call.arguments || '{}');
      let result = null;

      if (call.name === 'get_parent_by_email') {
        result = await getParentByEmail(args.email);
        toolContext.parent = result;
      }

      if (call.name === 'get_family_data') {
        result = await getFamilyData(args.parentId);
        toolContext.family = result;
      }

      outputs.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result),
      });
    }

    response = await openai.responses.create({
      model: 'gpt-5',
      previous_response_id: response.id,
      input: outputs,
      max_output_tokens: 3000,
      reasoning: { effort: 'low' },
    });
  }

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

  // ── Validation / defaults — don't trust the model's shape blindly ──

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

  // Context comes from whatever the model's tool calls actually returned —
  // default to "not found" if it never called the tools at all.
  const context = toolContext.family || {
    parentFound: false,
    parent: null,
    players: [],
    registrations: [],
    payments: [],
  };

  // Enforce confidence/review in code — don't rely solely on the model to
  // self-report when it actually had no data to work with.
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
    effectiveEmail: from,
    fromIsSiteOwned: false,
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

  // Reply to the resolved parent address when we have one (contact-form
  // submissions always arrive "from" info@bothellselect.com, so replying
  // to `from` directly would send the response back to ourselves).
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
  // Contact-form submissions arrive with "from" set to the site's own
  // address (info@bothellselect.com), not the visitor's. Replace it with
  // the parent's actual email — parsed out of the body — before anything
  // else touches this record, so `from` is always the real sender.
  const normalizedFrom = extractEmailAddress(emailData.from);
  let resolvedEmailData = emailData;

  if (SITE_OWNED_EMAILS.has(normalizedFrom)) {
    const bodyEmail = extractEmailFromBody(emailData.body);
    if (bodyEmail && !SITE_OWNED_EMAILS.has(bodyEmail)) {
      console.log(
        `"from" was site-owned address "${normalizedFrom}"; replacing with body email "${bodyEmail}".`,
      );
      resolvedEmailData = { ...emailData, from: bodyEmail };
    }
  }

  const aiEmail = await createAiEmail(resolvedEmailData);

  try {
    const result = await generateAiDraft({
      from: resolvedEmailData.from,
      subject: resolvedEmailData.subject || '',
      body: resolvedEmailData.body,
    });

    aiEmail.category = result.category;
    aiEmail.confidence = result.confidence;
    aiEmail.aiDraft = result.draft;
    aiEmail.aiReason = result.reason;
    aiEmail.dataUsed = result.dataUsed;
    aiEmail.replyToEmail = result.effectiveEmail || resolvedEmailData.from;

    if (result.parent) {
      // getParentByEmail returns `.id` (a string), not a Mongoose `._id`.
      aiEmail.parentId = result.parent.id || result.parent._id || null;
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

  getParentByEmail,
  getFamilyData,
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
