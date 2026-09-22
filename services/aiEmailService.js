require('dotenv').config();
const OpenAI = require('openai');
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

/**
 * Get the AI email assistant settings.
 *
 * There should only be one settings document.
 * If it does not exist yet, create it using the schema defaults.
 */
async function getAiSettings() {
  let settings = await AiSettings.findOne({ key: 'default' });

  if (!settings) {
    settings = await AiSettings.create({
      key: 'default',
    });
  }

  return settings;
}

/**
 * Find a parent by email address.
 */
async function findParent(email) {
  if (!email) return null;

  return Parent.findOne({
    email: email.toLowerCase().trim(),
  }).select('-password');
}

/**
 * Find a parent by ID.
 */
async function findParentById(parentId) {
  if (!parentId) return null;

  return Parent.findById(parentId).select('-password');
}

/**
 * Find all players belonging to a parent.
 */
async function findPlayersByParent(parentId) {
  if (!parentId) return [];

  return Player.find({
    parentId,
  });
}

/**
 * Find a player by ID.
 */
async function findPlayer(playerId) {
  if (!playerId) return null;

  return Player.findById(playerId);
}

/**
 * Find registrations for a specific player.
 */
async function findRegistrationsByPlayer(playerId) {
  if (!playerId) return [];

  return PlayerRegistration.find({
    playerId,
  }).sort({ createdAt: -1 });
}

/**
 * Find all registrations belonging to a parent's players.
 */
async function findRegistrationsByParent(parentId) {
  if (!parentId) return [];

  const players = await Player.find({
    parentId,
  }).select('_id');

  const playerIds = players.map((player) => player._id);

  if (playerIds.length === 0) return [];

  return PlayerRegistration.find({
    playerId: { $in: playerIds },
  }).sort({ createdAt: -1 });
}

/**
 * Find payments made by a parent.
 */
async function findPaymentsByParent(parentId) {
  if (!parentId) return [];

  return Payment.find({
    parentId,
  }).sort({ createdAt: -1 });
}

/**
 * Find payments associated with a player.
 *
 * Payments in this system can reference a player through:
 *   - playerId
 *   - playerIds
 *   - players.playerId
 */
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

/**
 * Find payments associated with a team.
 *
 * Payments can reference teams through:
 *   - teamId
 *   - teamIds
 */
async function findPaymentsByTeam(teamId) {
  if (!teamId) return [];

  return Payment.find({
    $or: [{ teamId }, { teamIds: teamId }],
  }).sort({ createdAt: -1 });
}

/**
 * Find a team by ID.
 */
async function findTeam(teamId) {
  if (!teamId) return null;

  return Team.findById(teamId);
}

/**
 * Find teams associated with a coach.
 *
 * Team records contain coachIds, not player IDs.
 */
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

/**
 * Create an incoming AI email record.
 *
 * This stores the original email before any AI processing occurs.
 */
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

/**
 * Get emails that are currently waiting for administrative action.
 */
async function getPendingAiEmails() {
  return AiEmail.find({
    status: {
      $in: ['new', 'draft_ready', 'reviewed'],
    },
  }).sort({
    receivedAt: -1,
  });
}

/**
 * Get one AI email by ID.
 */
async function getAiEmailById(id) {
  if (!id) return null;

  return AiEmail.findById(id);
}

/**
 * Build a safe, limited view of Bothell Select information
 * that can be provided to the AI.
 *
 * We deliberately do NOT send passwords or unrestricted database
 * information to OpenAI.
 */
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

/**
 * Generate an AI draft for an incoming parent email.
 *
 * Phase 1:
 * - AI may classify and draft.
 * - Human review is ALWAYS required.
 * - This function NEVER sends an email.
 */
async function generateAiDraft({ from, subject = '', body }) {
  if (!from) {
    throw new Error('from is required');
  }

  if (!body) {
    throw new Error('body is required');
  }

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
9. Do not send an email. You are only preparing a draft.
10. The draft should sound like a helpful Bothell Select administrator.
11. Keep the response concise unless the parent needs a detailed explanation.

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

Human review is ALWAYS required during the current phase.

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
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: userPrompt,
      },
    ],
  });

  const rawOutput = response.output_text;

  if (!rawOutput) {
    throw new Error('OpenAI returned an empty response');
  }

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

  result.requiresHumanReview = true;

  if (!Array.isArray(result.dataUsed)) {
    result.dataUsed = [];
  }

  if (!result.draft) {
    result.draft =
      'Thank you for contacting Bothell Select. We will review your message and get back to you shortly.';
  }

  if (!result.reason) {
    result.reason = 'AI generated a draft for administrative review.';
  }

  if (!result.reviewReason) {
    result.reviewReason = 'Human review is required during Phase 1.';
  }

  return {
    ...result,
    parent,
    context,
  };
}

/**
 * Create an AI email record and generate its draft.
 *
 * This is the main function we will eventually call when an
 * incoming email arrives from Proton.
 */
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
    aiEmail.requiresHumanReview = true;
    aiEmail.reviewReason = result.reviewReason;

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

    aiEmail.status = 'draft_ready';

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

module.exports = {
  getAiSettings,

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
  getAiEmailById,

  buildParentContext,
  generateAiDraft,
  processIncomingEmail,
};
