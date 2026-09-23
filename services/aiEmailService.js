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
// Parent / player / registration / payment / team lookups
// ─────────────────────────────────────────────────────────────────────────────

async function findParent(email) {
  if (!email) return null;
  return Parent.findOne({ email: email.toLowerCase().trim() }).select(
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
// AI context + draft generation
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
  const registrations = await findRegistrationsByParent(parent._id);
  const payments = await findPaymentsByParent(parent._id);

  return {
    parentFound: true,
    parent: {
      id: parent._id.toString(),
      firstName: parent.firstName || '',
      lastName: parent.lastName || '',
      email: parent.email || '',
      phone: parent.phone || '',
    },
    players: players.map((player) => ({
      id: player._id.toString(),
      firstName: player.firstName || '',
      lastName: player.lastName || '',
      grade: player.grade || '',
      gender: player.gender || '',
    })),
    registrations: registrations.map((registration) => ({
      id: registration._id.toString(),
      playerId: registration.playerId ? registration.playerId.toString() : null,
      status: registration.status || '',
      createdAt: registration.createdAt || null,
    })),
    payments: payments.map((payment) => ({
      id: payment._id.toString(),
      amount: payment.amount || null,
      status: payment.status || '',
      createdAt: payment.createdAt || null,
      playerId: payment.playerId ? payment.playerId.toString() : null,
      teamId: payment.teamId ? payment.teamId.toString() : null,
    })),
  };
}

async function generateAiDraft({ from, subject = '', body }) {
  if (!from) throw new Error('from is required');
  if (!body) throw new Error('body is required');

  const settings = await getAiSettings();
  const parent = await findParent(from);
  const context = await buildParentContext(parent);

  const systemPrompt = `
You are the Bothell Select parent email assistant.

Your job is to analyze an incoming email from a parent and prepare
a professional draft response for a human Bothell Select administrator
to review.

IMPORTANT RULES:

1. Never invent facts.
2. Only use information contained in the provided Bothell Select data.
3. If information is missing, say that the administrator needs to verify it.
4. Never claim a payment, registration, refund, schedule, team placement,
   or other action is confirmed unless the provided data confirms it.
5. Do not expose passwords, authentication information, or sensitive
   internal information.
6. Do not make decisions about team placement.
7. Do not approve refunds.
8. Do not resolve payment disputes automatically.
9. The draft should sound like a helpful Bothell Select administrator.
10. Keep the response concise unless the parent needs a detailed explanation.
11. Sign the response as "Bothell Select Basketball".

Available categories:

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

Return ONLY valid JSON with this exact structure:

{
  "category": "one of the allowed categories",
  "confidence": 0,
  "draft": "draft response",
  "reason": "short explanation of why this category and confidence were selected",
  "dataUsed": ["parent", "players", "registrations", "payments"],
  "requiresHumanReview": true,
  "reviewReason": "why a human should review this response"
}

Confidence must be a number from 0 to 100.
`;

  const userPrompt = `
Incoming parent email:

From: ${from}
Subject: ${subject}

Message:
${body}

Verified Bothell Select information:

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
  });

  const rawOutput = response.output_text;
  if (!rawOutput) throw new Error('OpenAI returned an empty response');

  let result;
  try {
    result = JSON.parse(rawOutput);
  } catch (error) {
    throw new Error(`OpenAI returned invalid JSON: ${rawOutput}`);
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
        .filter((registration) => registration.id)
        .map((registration) => registration.id);
    }

    if (result.context.payments) {
      aiEmail.paymentIds = result.context.payments
        .filter((payment) => payment.id)
        .map((payment) => payment.id);
    }

    // Decide whether to auto-send or leave for human review
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
    aiEmail.status = 'new';
    aiEmail.requiresHumanReview = true;
    aiEmail.reviewReason = 'AI processing failed and requires manual review.';
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
};
