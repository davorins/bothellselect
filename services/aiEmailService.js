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
// Email normalization
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
// DB lookups
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

function populateAiEmail(query) {
  return query
    .populate({ path: 'parentId', select: 'fullName email' })
    .populate({ path: 'playerIds', select: 'fullName' });
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
  const filter = { status: { $in: ['new', 'draft_ready', 'reviewed'] } };
  const skip = (Math.max(1, page) - 1) * limit;

  const [emails, total] = await Promise.all([
    populateAiEmail(
      AiEmail.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit),
    ),
    AiEmail.countDocuments(filter),
  ]);

  return { emails, total, page: Math.max(1, page), limit };
}

async function getAllAiEmails({ page = 1, limit = 25, status = null } = {}) {
  const filter = {};
  if (status) filter.status = status;
  const skip = (Math.max(1, page) - 1) * limit;

  const [emails, total] = await Promise.all([
    populateAiEmail(
      AiEmail.find(filter).sort({ receivedAt: -1 }).skip(skip).limit(limit),
    ),
    AiEmail.countDocuments(filter),
  ]);

  return { emails, total, page: Math.max(1, page), limit };
}

async function getAiEmailById(id) {
  if (!id) return null;
  return populateAiEmail(AiEmail.findById(id));
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
// AI tools
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
// AI draft generation
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

  return { error: `Unknown tool: ${call.function.name}` };
}

function buildSystemPrompt(settings) {
  const currentSeasonLine = CURRENT_TRYOUT_YEAR
    ? `
CURRENT SEASON
The current / upcoming season is "${CURRENT_TRYOUT_LABEL}" for year ${CURRENT_TRYOUT_YEAR}${
        CURRENT_TRYOUT_ID ? ` (tryoutId: ${CURRENT_TRYOUT_ID})` : ''
      }.
When a parent asks about "upcoming", "current", or "this year's" tryouts,
that refers to this season. Only fall back to mentioning other seasons if
the parent explicitly asks about a past one.
`.trim()
    : '';

  return `
You are the Bothell Select parent email assistant.

Your job is to analyze an incoming email from a parent and prepare a
professional draft response for a Bothell Select administrator.

You have access to two tools backed by the live database:
- get_parent_by_email: look up the parent account from the sender's email.
- get_family_data: given a parentId, get that family's players,
  registrations, payments, and teams.

ALWAYS call get_parent_by_email first, using the sender's email address.
If it finds a parent, ALWAYS follow up with get_family_data using that
parent's id before answering anything about registration or payment status.

${currentSeasonLine}

IMPORTANT RULES

1. Never invent facts. Only use what the tools return.
2. Match children by fullName within the family data. Common nicknames
   (Theo/Theodore, Alex/Alexander, etc.) may match — use context.
3. To answer "is my child registered?", check that child's
   registrationComplete field (both on the player and within their
   registrations for the current season).
4. To answer "did I pay?", check paymentComplete / paymentStatus for that
   child's current-season registration, and include amountPaid,
   paymentDate, and cardLast4 when confirming.
5. When the data unambiguously confirms what the parent asked (e.g.
   registrationComplete: true AND the current-season registration has
   paymentComplete: true for the exact child they mentioned), confirm it
   directly and confidently. Do NOT hedge with "appears to be" or
   "according to our records."
6. If get_parent_by_email finds no parent, or the child the parent asked
   about isn't in the family data, say the administrator needs to verify
   it manually — do NOT guess, and set confidence to 20 or lower.
7. Do not expose passwords or internal MongoDB ids.
8. Do not make team placement decisions or approve refunds.
9. Sound like a helpful Bothell Select administrator. Be warm and concise.
10. Sign the response as "Bothell Select Basketball".

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
`.trim();
}

async function generateAiDraft({ from, subject = '', body }) {
  if (!from) throw new Error('from is required');
  if (!body) throw new Error('body is required');

  const settings = await getAiSettings();
  const systemPrompt = buildSystemPrompt(settings);

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: `From: ${from}\nSubject: ${subject}\n\nMessage:\n${body}`,
    },
  ];

  const toolContext = {};
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
    effectiveEmail: from,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-send + sending
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
