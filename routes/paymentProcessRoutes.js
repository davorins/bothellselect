const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const PaymentConfiguration = require('../models/PaymentConfiguration');
const PaymentServiceFactory = require('../services/payment-service-factory');
const router = express.Router();
const mongoose = require('mongoose');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Registration = require('../models/Registration');
const Team = require('../models/Team');
const {
  sendTournamentRegistrationEmail,
  sendEmail,
} = require('../utils/email');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');

// ============================================
// DUPLICATE PAYMENT PREVENTION SYSTEM
// ============================================

// In-memory request tracking for duplicate prevention
const requestTracker = new Map();

// Clean up old entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of requestTracker.entries()) {
    if (now - entry.timestamp > 3600000) {
      // 1 hour
      requestTracker.delete(key);
    }
  }
}, 60000);

// Helper to generate request key
function generateRequestKey(parentId, amount, teamIds, players) {
  const data = {
    parentId,
    amount,
    teamIds: teamIds ? JSON.stringify(teamIds.sort()) : null,
    players: players
      ? JSON.stringify(players.map((p) => p.playerId).sort())
      : null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

// Helper to check for duplicate request
function isDuplicateRequest(requestKey) {
  if (requestTracker.has(requestKey)) {
    const entry = requestTracker.get(requestKey);
    // If the request is already processing or completed within last 30 seconds
    if (
      entry.status === 'processing' ||
      (entry.status === 'completed' && Date.now() - entry.timestamp < 30000)
    ) {
      return true;
    }
    // If it's been more than 30 seconds, allow retry
    if (entry.status === 'completed' && Date.now() - entry.timestamp >= 30000) {
      requestTracker.delete(requestKey);
      return false;
    }
  }
  return false;
}

// ============================================
// PAYMENT HELPERS
// ============================================

async function getPaymentService(paymentSystem = null) {
  return await PaymentServiceFactory.getService(paymentSystem);
}

async function getActivePaymentConfig() {
  return await PaymentConfiguration.findOne({ isActive: true }).sort({
    isDefault: -1,
    updatedAt: -1,
  });
}

function validateConfigForPayment(config, paymentType = 'tournament') {
  console.log('validateConfigForPayment called with:', {
    hasConfig: !!config,
    configId: config?._id,
    paymentSystem: config?.paymentSystem,
  });

  if (!config) {
    console.error('❌ validateConfigForPayment: No config provided');
    throw new Error('No active payment configuration found');
  }

  const { paymentSystem } = config;
  console.log('Validating payment system:', paymentSystem);

  switch (paymentSystem) {
    case 'square':
      if (!config.squareConfig?.accessToken) {
        console.error('❌ Square validation failed: Missing accessToken');
        throw new Error(
          'Square access token not configured. Please add it in Admin > Payment Configuration.',
        );
      }
      if (!config.squareConfig?.locationId) {
        console.error('❌ Square validation failed: Missing locationId');
        throw new Error('Square location ID not configured');
      }
      break;
    case 'clover':
      if (!config.cloverConfig?.accessToken) {
        console.error('❌ Clover validation failed: Missing accessToken');
        throw new Error('Clover access token not configured');
      }
      if (!config.cloverConfig?.merchantId) {
        console.error('❌ Clover validation failed: Missing merchantId');
        throw new Error('Clover merchant ID not configured');
      }
      break;
    default:
      console.error('❌ Unsupported payment system:', paymentSystem);
      throw new Error(`Unsupported payment system: ${paymentSystem}`);
  }

  console.log('✅ Config validation passed for:', paymentSystem);
  return true;
}

function createPaymentData(paymentService, paymentResult, baseData) {
  const paymentData = {
    ...baseData,
    paymentSystem: paymentService.type,
    configurationId: paymentService.configurationId,
    ...(paymentService.type === 'square' && {
      locationId: paymentService.config.locationId,
    }),
    ...(paymentService.type === 'clover' && {
      merchantId: paymentService.config.merchantId,
      orderId: paymentResult.orderId || paymentResult.id,
    }),
  };

  return paymentData;
}

// ============================================
// TOURNAMENT TEAM PAYMENT - SINGLE TEAM
// ============================================

router.post('/tournament-team', authenticate, async (req, res) => {
  console.log('=== TOURNAMENT PAYMENT REQUEST RECEIVED ===');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      token,
      sourceId,
      amount,
      email: buyerEmailAddress,
      teamId,
      tournament,
      year,
      cardDetails,
      paymentSystem,
      isAdmin = false,
      idempotencyKey,
    } = req.body;

    const parentId = req.user.id;
    const cardLastFour = cardDetails?.last_4 || req.body.cardLastFour || 'N/A';
    const cardBrand = cardDetails?.card_brand || req.body.cardBrand || 'N/A';
    const cardExpMonth = cardDetails?.exp_month || req.body.cardExpMonth || '0';
    const cardExpYear = cardDetails?.exp_year || req.body.cardExpYear || '0';

    // Generate unique request key for duplicate detection
    const requestKey = generateRequestKey(parentId, amount, [teamId], null);

    // Check for duplicate request
    if (isDuplicateRequest(requestKey)) {
      console.warn(
        '⚠️ Duplicate tournament payment request detected:',
        requestKey,
      );

      // Check if we already have a successful payment for this request
      const existingPayment = await Payment.findOne({
        parentId: parentId,
        teamId: teamId,
        tournamentName: tournament,
        year: parseInt(year),
        status: 'completed',
      }).sort({ createdAt: -1 });

      if (existingPayment) {
        return res.status(409).json({
          success: true,
          message: 'Payment already processed successfully',
          paymentId: existingPayment._id,
          externalPaymentId: existingPayment.paymentId,
          paymentSystem: existingPayment.paymentSystem,
          duplicate: true,
          receiptUrl: existingPayment.receiptUrl,
          amount: existingPayment.amount,
        });
      }

      return res.status(409).json({
        success: false,
        error:
          'Duplicate payment request detected. Please check your payment status.',
        duplicate: true,
      });
    }

    // Mark request as processing
    requestTracker.set(requestKey, {
      status: 'processing',
      timestamp: Date.now(),
    });

    console.log('Processing tournament team payment:', {
      teamId,
      tournament,
      year,
      amount,
      parentId,
      email: buyerEmailAddress,
      idempotencyKey,
      requestKey,
    });

    // Validate required fields
    if (!teamId) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Team ID is required',
      });
    }

    if (!tournament) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Tournament name is required',
      });
    }

    if (!year) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Year is required',
      });
    }

    if (!amount || amount <= 0) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    if (!token && !sourceId) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
      });
    }

    // Get payment service dynamically
    const paymentService = await getPaymentService(paymentSystem);
    console.log('Using payment service:', paymentService.type);

    // Validate configuration
    validateConfigForPayment(paymentService.configuration, 'tournament');

    // Get team and verify ownership
    const team = await Team.findOne({
      _id: teamId,
      coachIds: parentId,
    }).session(session);

    if (!team) {
      requestTracker.delete(requestKey);
      return res.status(404).json({
        success: false,
        error: 'Team not found or unauthorized',
      });
    }

    console.log('Team found:', team.name);

    // Check if tournament already paid
    const existingTournament = team.tournaments?.find(
      (t) =>
        t.tournamentName === tournament &&
        t.year === parseInt(year) &&
        t.paymentStatus === 'paid',
    );

    if (existingTournament) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'This tournament is already paid for this team',
      });
    }

    // Get parent for customer ID
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      requestTracker.delete(requestKey);
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    // Use existing customer ID or create new one
    let customerId;
    const customerField = `${paymentService.type}CustomerId`;
    customerId = parent[customerField];

    // Create customer if needed (for Square)
    if (!customerId && paymentService.type === 'square') {
      try {
        const { customersApi } = paymentService.client;
        const { result: customerResult } = await customersApi.createCustomer({
          emailAddress: buyerEmailAddress,
          referenceId: `parent:${parent._id}`,
        });
        customerId = customerResult.customer?.id;
        console.log('Created customer:', customerId);

        await Parent.updateOne(
          { _id: parentId },
          { $set: { [customerField]: customerId } },
          { session },
        );
      } catch (customerError) {
        console.error('Error creating customer:', customerError);
      }
    }

    // Process payment with the service
    let paymentResult;
    const amountInCents = parseInt(amount);
    const finalIdempotencyKey = idempotencyKey || crypto.randomUUID();

    if (paymentService.type === 'square') {
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
        },
        idempotencyKey: finalIdempotencyKey,
        locationId: paymentService.config.locationId,
        referenceId: `t:${teamId.slice(-12)}:${year}`,
        note: `Tournament registration: ${tournament} ${year} - Team: ${team.name}`,
        buyerEmailAddress,
        autocomplete: true,
      };

      if (customerId) {
        paymentRequest.customerId = customerId;
      }

      console.log('Creating payment request:', {
        paymentSystem: paymentService.type,
        locationId: paymentService.config.locationId,
        amount: amountInCents,
        idempotencyKey: finalIdempotencyKey,
      });

      const { result } =
        await paymentService.client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
    } else if (paymentService.type === 'clover') {
      const paymentData = {
        sourceId: sourceId || token,
        amount: amountInCents,
        email: buyerEmailAddress,
        referenceId: `t:${teamId.slice(-12)}:${year}`,
        note: `Tournament registration: ${tournament} ${year} - Team: ${team.name}`,
      };

      paymentResult = await paymentService.processPayment(paymentData);
    }

    if (!paymentResult) {
      requestTracker.delete(requestKey);
      throw new Error('No payment result received');
    }

    if (
      paymentResult.status !== 'COMPLETED' &&
      paymentResult.status !== 'PAID'
    ) {
      requestTracker.delete(requestKey);
      throw new Error(`Payment failed with status: ${paymentResult.status}`);
    }

    console.log(`${paymentService.type} payment completed successfully:`, {
      paymentId: paymentResult.id,
      status: paymentResult.status,
    });

    // Prepare tournament data
    const tournamentData = {
      tournamentName: tournament,
      year: parseInt(year),
      registrationDate: new Date(),
      paymentStatus: 'paid',
      paymentComplete: true,
      amountPaid: amount / 100,
      paymentId: paymentResult.id,
      paymentMethod: 'card',
      cardLast4: cardLastFour,
      cardBrand: cardBrand,
      levelOfCompetition: team.levelOfCompetition || 'Gold',
    };

    if (!team.tournaments) team.tournaments = [];

    const tournamentIndex = team.tournaments.findIndex(
      (t) =>
        (t.tournamentName === tournament || t.tournament === tournament) &&
        t.year === parseInt(year),
    );

    if (tournamentIndex >= 0) {
      team.tournaments[tournamentIndex] = tournamentData;
    } else {
      team.tournaments.push(tournamentData);
    }

    team.paymentComplete = true;
    team.paymentStatus = 'paid';
    team.updatedAt = new Date();
    team.markModified('tournaments');

    await team.save({ session });

    // Create Payment record
    const basePaymentData = {
      parentId: parent._id,
      teamId: teamId,
      paymentId: paymentResult.id,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardLastFour,
      cardBrand: cardBrand,
      cardExpMonth: cardExpMonth,
      cardExpYear: cardExpYear,
      amount: amount / 100,
      currency: paymentService.settings?.currency || 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      note: `Tournament: ${tournament} ${year} - Team: ${team.name}`,
      tournamentName: tournament,
      year: parseInt(year),
      paymentType: 'tournament',
      idempotencyKey: finalIdempotencyKey,
    };

    const payment = new Payment(
      createPaymentData(paymentService, paymentResult, basePaymentData),
    );
    await payment.save({ session });

    // Mark request as completed
    requestTracker.set(requestKey, {
      status: 'completed',
      timestamp: Date.now(),
      paymentId: payment._id,
    });

    // Send confirmation email
    try {
      await sendTournamentRegistrationEmail(
        parent._id,
        [teamId],
        tournament,
        year,
        amount / 100,
      );
      console.log('Tournament confirmation email sent successfully');
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
    }

    await session.commitTransaction();
    console.log('Transaction committed successfully');

    res.json({
      success: true,
      paymentId: payment._id,
      externalPaymentId: paymentResult.id,
      paymentSystem: paymentService.type,
      team: {
        _id: team._id,
        name: team.name,
        tournaments: team.tournaments,
      },
      payment: {
        paymentId: paymentResult.id,
        amountPaid: amount / 100,
        receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
        status: 'completed',
      },
      message: 'Tournament registration payment processed successfully',
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Tournament team payment error:', {
      message: error.message,
      stack: error.stack,
      requestBody: req.body,
      user: req.user?.id,
    });

    // Clean up request tracker on error
    const parentId = req.user?.id;
    if (parentId && req.body.teamId && req.body.amount) {
      const requestKey = generateRequestKey(
        parentId,
        req.body.amount,
        [req.body.teamId],
        null,
      );
      requestTracker.delete(requestKey);
    }

    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      message: error.message,
      details: process.env.NODE_ENV === 'development' ? error.stack : undefined,
    });
  } finally {
    session.endSession();
  }
});

// ============================================
// TOURNAMENT TEAMS PAYMENT - MULTIPLE TEAMS
// ============================================

router.post('/tournament-teams', authenticate, async (req, res) => {
  console.log('=== MULTIPLE TEAMS TOURNAMENT PAYMENT REQUEST RECEIVED ===');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      token,
      sourceId,
      amount,
      email: buyerEmailAddress,
      teamIds,
      tournament,
      year,
      cardDetails,
      paymentSystem,
      isAdmin = false,
      idempotencyKey,
    } = req.body;

    const parentId = req.user.id;
    const cardLastFour = cardDetails?.last_4 || req.body.cardLastFour || 'N/A';
    const cardBrand = cardDetails?.card_brand || req.body.cardBrand || 'N/A';
    const cardExpMonth = cardDetails?.exp_month || req.body.cardExpMonth || '0';
    const cardExpYear = cardDetails?.exp_year || req.body.cardExpYear || '0';

    // Generate unique request key for duplicate detection
    const requestKey = generateRequestKey(parentId, amount, teamIds, null);

    // Check for duplicate request
    if (isDuplicateRequest(requestKey)) {
      console.warn(
        '⚠️ Duplicate multiple teams tournament payment request detected:',
        requestKey,
      );

      // Check if we already have a successful payment for this request
      const existingPayment = await Payment.findOne({
        parentId: parentId,
        tournamentName: tournament,
        year: parseInt(year),
        status: 'completed',
      }).sort({ createdAt: -1 });

      if (existingPayment) {
        return res.status(409).json({
          success: true,
          message: 'Payment already processed successfully',
          paymentId: existingPayment._id,
          externalPaymentId: existingPayment.paymentId,
          paymentSystem: existingPayment.paymentSystem,
          duplicate: true,
          receiptUrl: existingPayment.receiptUrl,
          amount: existingPayment.amount,
        });
      }

      return res.status(409).json({
        success: false,
        error:
          'Duplicate payment request detected. Please check your payment status.',
        duplicate: true,
      });
    }

    // Mark request as processing
    requestTracker.set(requestKey, {
      status: 'processing',
      timestamp: Date.now(),
    });

    console.log('Processing multiple teams tournament payment:', {
      teamIds,
      tournament,
      year,
      amount,
      parentId,
      email: buyerEmailAddress,
      idempotencyKey,
      requestKey,
    });

    // Validate required fields
    if (!teamIds || !Array.isArray(teamIds) || teamIds.length === 0) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Team IDs are required',
      });
    }

    if (!tournament) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Tournament name is required',
      });
    }

    if (!year) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Year is required',
      });
    }

    if (!amount || amount <= 0) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    if (!token && !sourceId) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
      });
    }

    // Get payment service dynamically
    const paymentService = await getPaymentService(paymentSystem);
    console.log(
      'Using payment service for multiple teams:',
      paymentService.type,
    );

    // Validate configuration
    validateConfigForPayment(paymentService.configuration, 'tournament');

    // Get parent
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      requestTracker.delete(requestKey);
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    // Use existing customer ID or create new one
    let customerId;
    const customerField = `${paymentService.type}CustomerId`;
    customerId = parent[customerField];

    // Generate a unique idempotency key if not provided
    const finalIdempotencyKey = idempotencyKey || crypto.randomUUID();

    // Process payment
    let paymentResult;
    const amountInCents = parseInt(amount);

    if (paymentService.type === 'square') {
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
        },
        idempotencyKey: finalIdempotencyKey,
        locationId: paymentService.config.locationId,
        referenceId: `t:${parentId.slice(-12)}:${year}`,
        note: `Tournament registration: ${tournament} ${year} - ${teamIds.length} team(s)`,
        buyerEmailAddress,
        autocomplete: true,
      };

      if (customerId) {
        paymentRequest.customerId = customerId;
      }

      const { result } =
        await paymentService.client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
    } else if (paymentService.type === 'clover') {
      const paymentData = {
        sourceId: sourceId || token,
        amount: amountInCents,
        email: buyerEmailAddress,
        referenceId: `t:${parentId.slice(-12)}:${year}`,
        note: `Tournament registration: ${tournament} ${year} - ${teamIds.length} team(s)`,
      };

      paymentResult = await paymentService.processPayment(paymentData);
    }

    if (
      !paymentResult ||
      (paymentResult.status !== 'COMPLETED' && paymentResult.status !== 'PAID')
    ) {
      requestTracker.delete(requestKey);
      throw new Error(`Payment failed with status: ${paymentResult?.status}`);
    }

    console.log(
      `${paymentService.type} payment completed successfully for multiple teams`,
    );

    // Process each team
    const updatedTeams = [];
    const teamCount = teamIds.length;
    const amountPerTeam = amount / 100 / teamCount;
    const invalidTeams = [];

    for (const teamId of teamIds) {
      const team = await Team.findOne({
        _id: teamId,
        coachIds: parentId,
      }).session(session);

      if (!team) {
        invalidTeams.push(teamId);
        continue;
      }

      // Check if tournament already paid
      const existingTournament = team.tournaments?.find(
        (t) =>
          t.tournament === tournament &&
          t.year === parseInt(year) &&
          t.paymentStatus === 'paid',
      );

      if (existingTournament) {
        // Skip this team but continue with others
        continue;
      }

      // Update team tournament payment status
      const tournamentIndex = team.tournaments.findIndex(
        (t) => t.tournament === tournament && t.year === parseInt(year),
      );

      const tournamentData = {
        tournament: tournament,
        year: parseInt(year),
        paymentStatus: 'paid',
        paymentComplete: true,
        paymentDate: new Date(),
        paymentId: paymentResult.id,
        cardLast4: cardLastFour,
        cardBrand: cardBrand,
        amountPaid: amountPerTeam,
        levelOfCompetition: team.levelOfCompetition || 'Silver',
      };

      if (tournamentIndex >= 0) {
        team.tournaments[tournamentIndex] = tournamentData;
      } else {
        team.tournaments.push(tournamentData);
      }

      team.markModified('tournaments');
      await team.save({ session });
      updatedTeams.push(team);
    }

    if (updatedTeams.length === 0) {
      requestTracker.delete(requestKey);
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No teams processed',
        invalidTeams: invalidTeams,
      });
    }

    // Create Payment record
    const basePaymentData = {
      parentId: parent._id,
      teamIds: updatedTeams.map((team) => team._id),
      paymentId: paymentResult.id,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardLastFour,
      cardBrand: cardBrand,
      cardExpMonth: cardExpMonth,
      cardExpYear: cardExpYear,
      amount: amount / 100,
      currency: paymentService.settings?.currency || 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      note: `Tournament: ${tournament} ${year} - ${teamIds.length} team(s)`,
      tournamentName: tournament,
      year: parseInt(year),
      paymentType: 'tournament',
      idempotencyKey: finalIdempotencyKey,
      metadata: {
        teamCount: teamIds.length,
        tournament,
        year,
        amountPerTeam: amountPerTeam,
        teamIds: teamIds,
      },
    };

    const payment = new Payment(
      createPaymentData(paymentService, paymentResult, basePaymentData),
    );
    await payment.save({ session });

    // Mark request as completed
    requestTracker.set(requestKey, {
      status: 'completed',
      timestamp: Date.now(),
      paymentId: payment._id,
    });

    // Send confirmation email
    try {
      await sendTournamentRegistrationEmail(
        parent._id,
        updatedTeams.map((team) => team._id),
        tournament,
        year,
        amount / 100,
      );
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
    }

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: payment._id,
      externalPaymentId: paymentResult.id,
      paymentSystem: paymentService.type,
      teams: updatedTeams.map((team) => ({
        _id: team._id,
        name: team.name,
        tournaments: team.tournaments,
      })),
      payment: {
        paymentId: paymentResult.id,
        amountPaid: amount / 100,
        receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
        status: 'completed',
      },
      message: `Tournament registration payment processed successfully for ${updatedTeams.length} team(s)`,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Multiple teams tournament payment error:', error);

    // Clean up request tracker on error
    const parentId = req.user?.id;
    if (parentId && req.body.teamIds && req.body.amount) {
      const requestKey = generateRequestKey(
        parentId,
        req.body.amount,
        req.body.teamIds,
        null,
      );
      requestTracker.delete(requestKey);
    }

    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      message: error.message,
    });
  } finally {
    session.endSession();
  }
});

// ============================================
// TRYOUT PAYMENT
// ============================================

router.post(
  '/tryout',
  authenticate,
  [
    body('token').notEmpty().withMessage('Payment token is required'),
    body('amount')
      .isInt({ min: 1 })
      .withMessage('Amount must be a positive integer'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('players')
      .isArray({ min: 1 })
      .withMessage('At least one player is required'),
    body('players.*.playerId')
      .notEmpty()
      .custom((value) => mongoose.Types.ObjectId.isValid(value))
      .withMessage('Valid playerId is required'),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030'),
    body('players.*.tryoutId')
      .notEmpty()
      .isString()
      .withMessage('Tryout ID is required'),
    body('cardDetails').isObject().withMessage('Card details are required'),
    body('cardDetails.last_4')
      .isLength({ min: 4, max: 4 })
      .withMessage('Invalid card last 4 digits'),
    body('cardDetails.card_brand')
      .notEmpty()
      .withMessage('Card brand is required'),
    body('cardDetails.exp_month')
      .isInt({ min: 1, max: 12 })
      .withMessage('Invalid expiration month'),
    body('cardDetails.exp_year')
      .isInt({ min: new Date().getFullYear() })
      .withMessage('Invalid expiration year'),
    body('paymentSystem')
      .optional()
      .isIn(['square', 'clover'])
      .withMessage('Payment system must be square or clover'),
    body('idempotencyKey')
      .optional()
      .isString()
      .withMessage('idempotencyKey must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ VALIDATION ERRORS:', errors.array());
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: `Validation failed: ${errors
          .array()
          .map((err) => err.msg)
          .join(', ')}`,
      });
    }

    const {
      token,
      sourceId,
      amount,
      email,
      players,
      cardDetails,
      paymentSystem,
      idempotencyKey,
    } = req.body;

    const perPlayerAmount = amount / 100 / players.length;
    const parentId = req.user.id;
    const cardLastFour = cardDetails?.last_4 || '';
    const cardBrand = cardDetails?.card_brand || '';
    const cardExpMonth = cardDetails?.exp_month || 0;
    const cardExpYear = cardDetails?.exp_year || 0;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Generate unique request key for duplicate detection
      const requestKey = generateRequestKey(parentId, amount, null, players);

      // Check for duplicate request
      if (isDuplicateRequest(requestKey)) {
        console.warn(
          '⚠️ Duplicate tryout payment request detected:',
          requestKey,
        );

        // Check if we already have a successful payment for this request
        const playerIds = players.map((p) => p.playerId).sort();
        const existingPayment = await Payment.findOne({
          parentId: parentId,
          paymentType: 'tryout',
          status: 'completed',
          'players.playerId': { $all: playerIds },
          'players.tryoutId': players[0].tryoutId,
          'players.year': players[0].year,
        }).sort({ createdAt: -1 });

        if (existingPayment) {
          return res.status(409).json({
            success: true,
            message: 'Payment already processed successfully',
            paymentId: existingPayment._id,
            externalPaymentId: existingPayment.paymentId,
            paymentSystem: existingPayment.paymentSystem,
            duplicate: true,
            receiptUrl: existingPayment.receiptUrl,
            amount: existingPayment.amount,
          });
        }

        return res.status(409).json({
          success: false,
          error:
            'Duplicate payment request detected. Please check your payment status.',
          duplicate: true,
        });
      }

      // Mark request as processing
      requestTracker.set(requestKey, {
        status: 'processing',
        timestamp: Date.now(),
      });

      console.log('Processing tryout payment:', {
        parentId,
        playerIds: players.map((p) => p.playerId),
        amount: amount / 100,
        playerCount: players.length,
        requestedPaymentSystem: paymentSystem,
      });

      // Get payment service
      const paymentService = await getPaymentService(paymentSystem);
      console.log('Using payment service for tryout:', paymentService.type);

      // Validate configuration
      validateConfigForPayment(paymentService.configuration, 'tryout');

      // Verify parent exists
      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        requestTracker.delete(requestKey);
        throw new Error('Parent not found');
      }

      // Generate a unique idempotency key if not provided
      const finalIdempotencyKey = idempotencyKey || crypto.randomUUID();

      // Process payment
      let paymentResult;
      const amountInCents = parseInt(amount);

      if (paymentService.type === 'square') {
        const paymentRequest = {
          sourceId: sourceId || token,
          amountMoney: {
            amount: amountInCents,
            currency: paymentService.settings?.currency || 'USD',
          },
          idempotencyKey: finalIdempotencyKey,
          locationId: paymentService.config.locationId,
          customerId: parent.squareCustomerId,
          referenceId: `parent:${parent._id}`,
          note: `Tryout payment for ${players.length} player(s)`,
          buyerEmailAddress: email,
          autocomplete: true,
        };

        const { result } =
          await paymentService.client.paymentsApi.createPayment(paymentRequest);
        paymentResult = result.payment;
      } else if (paymentService.type === 'clover') {
        const paymentData = {
          sourceId: sourceId || token,
          amount: amountInCents,
          email: email,
          referenceId: `parent:${parent._id}`,
          note: `Tryout payment for ${players.length} player(s)`,
        };

        paymentResult = await paymentService.processPayment(paymentData);
      }

      if (
        !paymentResult ||
        (paymentResult.status !== 'COMPLETED' &&
          paymentResult.status !== 'PAID')
      ) {
        requestTracker.delete(requestKey);
        throw new Error(`Payment failed with status: ${paymentResult?.status}`);
      }

      // Create Payment record
      const basePaymentData = {
        parentId: parent._id,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
        paymentId: paymentResult.id,
        buyerEmail: email,
        cardLastFour: cardLastFour,
        cardBrand: cardBrand,
        cardExpMonth: cardExpMonth,
        cardExpYear: cardExpYear,
        amount: amount / 100,
        currency: paymentService.settings?.currency || 'USD',
        status: 'completed',
        processedAt: new Date(),
        receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
        players: players.map((p) => ({
          playerId: p.playerId,
          season: p.season.trim(),
          year: p.year,
          tryoutId: p.tryoutId.trim(),
        })),
        paymentType: 'tryout',
        idempotencyKey: finalIdempotencyKey,
      };

      const payment = new Payment(
        createPaymentData(paymentService, paymentResult, basePaymentData),
      );
      await payment.save({ session });

      // Update all players and their seasons
      const updatedPlayers = [];
      for (const playerData of players) {
        const normalizedSeason = playerData.season.trim();
        const normalizedTryoutId = playerData.tryoutId.trim();

        const player = await Player.findById(playerData.playerId).session(
          session,
        );

        if (!player) {
          throw new Error(`Player not found for ID: ${playerData.playerId}`);
        }

        const parentHasPlayer = parent.players.some(
          (pid) => pid.toString() === player._id.toString(),
        );

        if (!parentHasPlayer && req.user.role !== 'admin') {
          throw new Error(
            `Unauthorized access to player: ${playerData.playerId}`,
          );
        }

        // Look for pending seasons
        const pendingSeasonIndex = player.seasons.findIndex(
          (s) =>
            s.season.trim().toLowerCase() === normalizedSeason.toLowerCase() &&
            s.year === playerData.year &&
            s.paymentStatus === 'pending' &&
            (s.tryoutId.trim().toLowerCase().includes('spring') ||
              s.tryoutId.trim().toLowerCase().includes('tryout')),
        );

        if (pendingSeasonIndex >= 0) {
          player.seasons[pendingSeasonIndex] = {
            ...player.seasons[pendingSeasonIndex],
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentId: paymentResult.id,
            amountPaid: perPlayerAmount,
            cardLast4: cardLastFour,
            cardBrand: cardBrand,
            paymentDate: new Date(),
            registrationDate:
              player.seasons[pendingSeasonIndex].registrationDate || new Date(),
          };
        } else {
          // Add new season
          player.seasons.push({
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentId: paymentResult.id,
            amountPaid: perPlayerAmount,
            cardLast4: cardLastFour,
            cardBrand: cardBrand,
            paymentDate: new Date(),
            registrationDate: new Date(),
          });
        }

        player.paymentStatus = 'paid';
        player.paymentComplete = true;
        player.registrationComplete = true;
        player.lastPaymentDate = new Date();
        player.markModified('seasons');

        const updatedPlayer = await player.save({ session });
        updatedPlayers.push(updatedPlayer);

        // Update registration
        await Registration.findOneAndUpdate(
          {
            player: updatedPlayer._id,
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            parent: parent._id,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentId: paymentResult.id,
              amountPaid: perPlayerAmount,
              cardLast4: cardLastFour,
              cardBrand: cardBrand,
              paymentDate: new Date(),
              registrationComplete: true,
              updatedAt: new Date(),
              parent: parent._id,
            },
          },
          { upsert: true, new: true, session },
        );
      }

      // Update parent
      await Parent.findByIdAndUpdate(
        parent._id,
        {
          $set: {
            paymentComplete: true,
            updatedAt: new Date(),
          },
        },
        { session },
      );

      // Mark request as completed
      requestTracker.set(requestKey, {
        status: 'completed',
        timestamp: Date.now(),
        paymentId: payment._id,
      });

      // Send receipt email
      try {
        await sendEmail({
          to: email,
          subject: 'Payment Confirmation - Bothell Select Basketball',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
              </div>
              <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
                <h1 style="margin: 0;">🎉 Payment Confirmed!</h1>
              </div>
              <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
                <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
                <p style="font-size: 16px;">Thank you for your payment! Your registration has been confirmed.</p>
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
                  <h3 style="margin-top: 0; color: rgba(0, 0, 0, .7);">Payment Details</h3>
                  <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
                  <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${amount / 100}</p>
                  <p style="margin: 8px 0;"><strong>Payment ID:</strong> ${paymentResult.id}</p>
                  <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
                  <ul style="margin: 8px 0;">
                    ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
                  </ul>
                </div>
                <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
                <p style="font-size: 16px; font-weight: bold;">Welcome to the Bothell Select family! 🏀</p>
              </div>
            </div>
          `,
        });
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
      }

      await session.commitTransaction();

      res.status(200).json({
        success: true,
        paymentId: payment._id,
        externalPaymentId: paymentResult.id,
        paymentSystem: paymentService.type,
        parentUpdated: true,
        playersUpdated: updatedPlayers.length,
        playerIds: updatedPlayers.map((p) => p._id.toString()),
        players: updatedPlayers.map((p) => ({
          _id: p._id,
          fullName: p.fullName,
          paymentStatus: p.paymentStatus,
          paymentComplete: p.paymentComplete,
          registrationComplete: p.registrationComplete,
          seasons: p.seasons.map((s) => ({
            season: s.season,
            year: s.year,
            tryoutId: s.tryoutId,
            paymentStatus: s.paymentStatus,
            paymentComplete: s.paymentComplete,
            paymentDate: s.paymentDate,
            registrationDate: s.registrationDate,
          })),
        })),
        status: 'processed',
        receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Payment processing error:', error);

      // Clean up request tracker on error
      const parentId = req.user?.id;
      if (parentId && req.body.players && req.body.amount) {
        const requestKey = generateRequestKey(
          parentId,
          req.body.amount,
          null,
          req.body.players,
        );
        requestTracker.delete(requestKey);
      }

      res.status(400).json({
        success: false,
        error: 'Tryout payment processing failed',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    } finally {
      session.endSession();
    }
  },
);

// ============================================
// TRAINING PAYMENT
// ============================================

router.post(
  '/training',
  authenticate,
  [
    body('token')
      .optional()
      .notEmpty()
      .withMessage('Payment token is required if sourceId is not provided'),
    body('sourceId')
      .optional()
      .notEmpty()
      .withMessage('Payment sourceId is required if token is not provided'),
    body().custom((value, { req }) => {
      if (!req.body.token && !req.body.sourceId) {
        throw new Error('Either token or sourceId must be provided');
      }
      return true;
    }),
    body('amount')
      .isInt({ min: 1 })
      .withMessage('Amount must be a positive integer'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('players')
      .isArray({ min: 1 })
      .withMessage('At least one player is required'),
    body('players.*.playerId')
      .notEmpty()
      .custom((value) => mongoose.Types.ObjectId.isValid(value))
      .withMessage('Valid playerId is required'),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030'),
    body('players.*.tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'),
    body('cardDetails')
      .optional()
      .isObject()
      .withMessage('Card details must be an object'),
    body('cardDetails.last_4')
      .optional()
      .isLength({ min: 4, max: 4 })
      .withMessage('Invalid card last 4 digits'),
    body('cardDetails.card_brand')
      .optional()
      .notEmpty()
      .withMessage('Card brand is required if card details provided'),
    body('cardDetails.exp_month')
      .optional()
      .isInt({ min: 1, max: 12 })
      .withMessage('Invalid expiration month'),
    body('cardDetails.exp_year')
      .optional()
      .isInt({ min: new Date().getFullYear() })
      .withMessage('Invalid expiration year'),
    body('paymentSystem')
      .optional()
      .isIn(['square', 'clover'])
      .withMessage('Payment system must be square or clover'),
    body('idempotencyKey')
      .optional()
      .isString()
      .withMessage('idempotencyKey must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('❌ TRAINING PAYMENT VALIDATION ERRORS:', errors.array());
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: `Training payment validation failed: ${errors
          .array()
          .map((err) => err.msg)
          .join(', ')}`,
      });
    }

    const {
      token,
      sourceId,
      amount,
      email,
      players,
      cardDetails = {},
      paymentSystem,
      idempotencyKey,
    } = req.body;

    const perPlayerAmount = amount / 100 / players.length;
    const parentId = req.user.id;
    const cardLastFour = cardDetails?.last_4 || '';
    const cardBrand = cardDetails?.card_brand || '';
    const cardExpMonth = cardDetails?.exp_month || 0;
    const cardExpYear = cardDetails?.exp_year || 0;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Generate unique request key for duplicate detection
      const requestKey = generateRequestKey(parentId, amount, null, players);

      if (isDuplicateRequest(requestKey)) {
        console.warn(
          '⚠️ Duplicate training payment request detected:',
          requestKey,
        );
        const playerIds = players.map((p) => p.playerId).sort();
        const existingPayment = await Payment.findOne({
          parentId: parentId,
          paymentType: 'training',
          status: 'completed',
          'players.playerId': { $all: playerIds },
          'players.year': players[0].year,
        }).sort({ createdAt: -1 });

        if (existingPayment) {
          return res.status(409).json({
            success: true,
            message: 'Payment already processed successfully',
            paymentId: existingPayment._id,
            externalPaymentId: existingPayment.paymentId,
            paymentSystem: existingPayment.paymentSystem,
            duplicate: true,
            receiptUrl: existingPayment.receiptUrl,
            amount: existingPayment.amount,
          });
        }
        return res.status(409).json({
          success: false,
          error:
            'Duplicate payment request detected. Please check your payment status.',
          duplicate: true,
        });
      }

      requestTracker.set(requestKey, {
        status: 'processing',
        timestamp: Date.now(),
      });

      console.log('Processing training payment:', {
        parentId,
        playerIds: players.map((p) => p.playerId),
        amount: amount / 100,
        playerCount: players.length,
      });

      const paymentService = await getPaymentService(paymentSystem);
      console.log('Using payment service for training:', paymentService.type);

      validateConfigForPayment(paymentService.configuration, 'training');

      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        requestTracker.delete(requestKey);
        throw new Error('Parent not found');
      }

      const finalIdempotencyKey = idempotencyKey || crypto.randomUUID();

      let paymentResult;
      const amountInCents = parseInt(amount);

      if (paymentService.type === 'square') {
        const shortRefId =
          `tr:${parent._id.toString().slice(-12)}:${Date.now().toString().slice(-8)}`.slice(
            0,
            40,
          );

        const paymentRequest = {
          sourceId: sourceId || token,
          amountMoney: {
            amount: amountInCents,
            currency: paymentService.settings?.currency || 'USD',
          },
          idempotencyKey: finalIdempotencyKey,
          locationId: paymentService.config.locationId,
          customerId: parent.squareCustomerId,
          referenceId: shortRefId,
          note: `Training payment for ${players.length} player(s)`,
          buyerEmailAddress: email,
          autocomplete: true,
        };

        const { result } =
          await paymentService.client.paymentsApi.createPayment(paymentRequest);
        paymentResult = result.payment;
      } else if (paymentService.type === 'clover') {
        const paymentData = {
          sourceId: sourceId || token,
          amount: amountInCents,
          email: email,
          referenceId: `training:${parent._id}:${Date.now()}`,
          note: `Training payment for ${players.length} player(s)`,
        };

        paymentResult = await paymentService.processPayment(paymentData);
      }

      if (
        !paymentResult ||
        (paymentResult.status !== 'COMPLETED' &&
          paymentResult.status !== 'PAID')
      ) {
        requestTracker.delete(requestKey);
        throw new Error(`Payment failed with status: ${paymentResult?.status}`);
      }

      const basePaymentData = {
        parentId: parent._id,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
        paymentId: paymentResult.id,
        buyerEmail: email,
        cardLastFour: cardLastFour,
        cardBrand: cardBrand,
        cardExpMonth: cardExpMonth,
        cardExpYear: cardExpYear,
        amount: amount / 100,
        currency: paymentService.settings?.currency || 'USD',
        status: 'completed',
        processedAt: new Date(),
        receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
        players: players.map((p) => ({
          playerId: p.playerId,
          season: p.season.trim(),
          year: p.year,
          tryoutId: p.tryoutId?.trim() || 'training',
        })),
        paymentType: 'training',
        idempotencyKey: finalIdempotencyKey,
      };

      const payment = new Payment(
        createPaymentData(paymentService, paymentResult, basePaymentData),
      );
      await payment.save({ session });

      const updatedPlayers = [];
      for (const playerData of players) {
        const normalizedSeason = playerData.season.trim();
        const normalizedTryoutId = playerData.tryoutId?.trim() || 'training';

        const player = await Player.findById(playerData.playerId).session(
          session,
        );

        if (!player) {
          throw new Error(`Player not found for ID: ${playerData.playerId}`);
        }

        const parentHasPlayer = parent.players.some(
          (pid) => pid.toString() === player._id.toString(),
        );

        if (!parentHasPlayer && req.user.role !== 'admin') {
          throw new Error(
            `Unauthorized access to player: ${playerData.playerId}`,
          );
        }

        const pendingTrainingSeasonIndex = player.seasons.findIndex((s) => {
          const isTrainingSeason =
            s.season?.toLowerCase().includes('training') ||
            s.season === 'Basketball Training' ||
            s.season === 'Training' ||
            s.season === normalizedSeason;
          const isSameYear = s.year === playerData.year;
          const isPending = s.paymentStatus === 'pending';
          const isSameTryout = s.tryoutId === normalizedTryoutId;

          return isTrainingSeason && isSameYear && isSameTryout && isPending;
        });

        if (pendingTrainingSeasonIndex >= 0) {
          player.seasons[pendingTrainingSeasonIndex] = {
            ...player.seasons[pendingTrainingSeasonIndex],
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentId: paymentResult.id,
            amountPaid: perPlayerAmount,
            cardLast4: cardLastFour,
            cardBrand: cardBrand,
            paymentDate: new Date(),
            registrationDate:
              player.seasons[pendingTrainingSeasonIndex].registrationDate ||
              new Date(),
          };
        } else {
          player.seasons.push({
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentId: paymentResult.id,
            amountPaid: perPlayerAmount,
            cardLast4: cardLastFour,
            cardBrand: cardBrand,
            paymentDate: new Date(),
            registrationDate: new Date(),
          });
        }

        player.paymentStatus = 'paid';
        player.paymentComplete = true;
        player.registrationComplete = true;
        player.lastPaymentDate = new Date();
        player.markModified('seasons');

        const updatedPlayer = await player.save({ session });
        updatedPlayers.push(updatedPlayer);

        await Registration.findOneAndUpdate(
          {
            player: updatedPlayer._id,
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            parent: parent._id,
          },
          {
            $set: {
              paymentStatus: 'paid',
              paymentComplete: true,
              paymentId: paymentResult.id,
              amountPaid: perPlayerAmount,
              cardLast4: cardLastFour,
              cardBrand: cardBrand,
              paymentDate: new Date(),
              registrationComplete: true,
              updatedAt: new Date(),
              parent: parent._id,
            },
          },
          { upsert: true, new: true, session },
        );
      }

      await Parent.findByIdAndUpdate(
        parent._id,
        {
          $set: {
            paymentComplete: true,
            updatedAt: new Date(),
          },
        },
        { session },
      );

      requestTracker.set(requestKey, {
        status: 'completed',
        timestamp: Date.now(),
        paymentId: payment._id,
      });

      try {
        await sendEmail({
          to: email,
          subject: 'Training Payment Confirmation - Bothell Select Basketball',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
              </div>
              <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
                <h1 style="margin: 0;">🏀 Training Payment Confirmed!</h1>
              </div>
              <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
                <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
                <p style="font-size: 16px;">Thank you for your training payment! Your registration has been confirmed.</p>
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
                  <h3 style="margin-top: 0; color: rgba(0, 0, 0, .7);">Training Payment Details</h3>
                  <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
                  <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${amount / 100}</p>
                  <p style="margin: 8px 0;"><strong>Payment ID:</strong> ${paymentResult.id}</p>
                  <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
                  <ul style="margin: 8px 0;">
                    ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
                  </ul>
                </div>
                <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
                <p style="font-size: 16px; font-weight: bold;">We look forward to training with you! 🏀</p>
              </div>
            </div>
          `,
        });
      } catch (emailError) {
        console.error(
          'Failed to send training confirmation email:',
          emailError,
        );
      }

      await session.commitTransaction();

      res.status(200).json({
        success: true,
        paymentId: payment._id,
        externalPaymentId: paymentResult.id,
        paymentSystem: paymentService.type,
        parentUpdated: true,
        playersUpdated: updatedPlayers.length,
        playerIds: updatedPlayers.map((p) => p._id.toString()),
        players: updatedPlayers.map((p) => ({
          _id: p._id,
          fullName: p.fullName,
          paymentStatus: p.paymentStatus,
          paymentComplete: p.paymentComplete,
          registrationComplete: p.registrationComplete,
          seasons: p.seasons.filter(
            (s) =>
              s.season?.toLowerCase().includes('training') ||
              s.season === 'Basketball Training' ||
              s.season === 'Training',
          ),
        })),
        status: 'processed',
        receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
        message: 'Training payment processed successfully',
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Training payment processing error:', error);

      const parentId = req.user?.id;
      if (parentId && req.body.players && req.body.amount) {
        const requestKey = generateRequestKey(
          parentId,
          req.body.amount,
          null,
          req.body.players,
        );
        requestTracker.delete(requestKey);
      }

      res.status(400).json({
        success: false,
        error: 'Training payment processing failed',
        message: error.message,
        details:
          process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    } finally {
      session.endSession();
    }
  },
);

// ============================================
// GENERAL PAYMENT PROCESS
// ============================================

router.post('/process', authenticate, async (req, res) => {
  console.log('=== PAYMENT PROCESS REQUEST RECEIVED ===');

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      token,
      sourceId,
      amount,
      email: buyerEmailAddress,
      players,
      cardDetails,
      paymentSystem,
      idempotencyKey,
    } = req.body;

    const parentId = req.user.id;
    const cardLastFour = cardDetails?.last_4 || req.body.cardLastFour || 'N/A';
    const cardBrand = cardDetails?.card_brand || req.body.cardBrand || 'N/A';
    const cardExpMonth = cardDetails?.exp_month || req.body.cardExpMonth || '0';
    const cardExpYear = cardDetails?.exp_year || req.body.cardExpYear || '0';

    // Generate unique request key for duplicate detection
    const requestKey = generateRequestKey(parentId, amount, null, players);

    if (isDuplicateRequest(requestKey)) {
      console.warn(
        '⚠️ Duplicate general payment request detected:',
        requestKey,
      );
      const playerIds = players.map((p) => p.playerId).sort();
      const existingPayment = await Payment.findOne({
        parentId: parentId,
        paymentType: 'general',
        status: 'completed',
        'players.playerId': { $all: playerIds },
      }).sort({ createdAt: -1 });

      if (existingPayment) {
        return res.status(409).json({
          success: true,
          message: 'Payment already processed successfully',
          paymentId: existingPayment._id,
          externalPaymentId: existingPayment.paymentId,
          paymentSystem: existingPayment.paymentSystem,
          duplicate: true,
          receiptUrl: existingPayment.receiptUrl,
          amount: existingPayment.amount,
        });
      }
      return res.status(409).json({
        success: false,
        error:
          'Duplicate payment request detected. Please check your payment status.',
        duplicate: true,
      });
    }

    requestTracker.set(requestKey, {
      status: 'processing',
      timestamp: Date.now(),
    });

    console.log('Processing general payment:', {
      parentId,
      playerCount: players?.length,
      amount,
      email: buyerEmailAddress,
      requestedPaymentSystem: paymentSystem,
    });

    if (!players || !Array.isArray(players) || players.length === 0) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Players data is required',
      });
    }

    if (!amount || amount <= 0) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    if (!token && !sourceId) {
      requestTracker.delete(requestKey);
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
      });
    }

    const paymentService = await getPaymentService(paymentSystem);
    console.log(
      'Using payment service for general payment:',
      paymentService.type,
    );

    validateConfigForPayment(paymentService.configuration, 'general');

    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      requestTracker.delete(requestKey);
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    let customerId;
    const customerField = `${paymentService.type}CustomerId`;
    customerId = parent[customerField];

    let paymentResult;
    const amountInCents = parseInt(amount);
    const perPlayerAmount = amount / 100 / players.length;
    const finalIdempotencyKey = idempotencyKey || crypto.randomUUID();

    if (paymentService.type === 'square') {
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
        },
        idempotencyKey: finalIdempotencyKey,
        locationId: paymentService.config.locationId,
        referenceId: `parent:${parent._id}`,
        note: `Payment for ${players.length} player(s)`,
        buyerEmailAddress,
        autocomplete: true,
      };

      if (customerId) {
        paymentRequest.customerId = customerId;
      }

      const { result } =
        await paymentService.client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
    } else if (paymentService.type === 'clover') {
      const paymentData = {
        sourceId: sourceId || token,
        amount: amountInCents,
        email: buyerEmailAddress,
        referenceId: `parent:${parent._id}`,
        note: `Payment for ${players.length} player(s)`,
      };

      paymentResult = await paymentService.processPayment(paymentData);
    }

    if (
      !paymentResult ||
      (paymentResult.status !== 'COMPLETED' && paymentResult.status !== 'PAID')
    ) {
      requestTracker.delete(requestKey);
      throw new Error(`Payment failed with status: ${paymentResult?.status}`);
    }

    console.log(`${paymentService.type} payment completed successfully`);

    const updatedPlayers = [];

    for (const playerData of players) {
      const player = await Player.findById(playerData.playerId).session(
        session,
      );

      if (!player) {
        throw new Error(`Player not found for ID: ${playerData.playerId}`);
      }

      const parentHasPlayer = parent.players.some(
        (pid) => pid.toString() === player._id.toString(),
      );

      if (!parentHasPlayer && req.user.role !== 'admin') {
        throw new Error(
          `Unauthorized access to player: ${playerData.playerId}`,
        );
      }

      const pendingSeasonIndex = player.seasons.findIndex(
        (s) =>
          s.season === playerData.season &&
          s.year === playerData.year &&
          s.paymentStatus === 'pending',
      );

      const seasonUpdate = {
        season: playerData.season,
        year: playerData.year,
        tryoutId: playerData.tryoutId,
        paymentStatus: 'paid',
        paymentComplete: true,
        paymentId: paymentResult.id,
        amountPaid: perPlayerAmount,
        cardLast4: cardLastFour,
        cardBrand: cardBrand,
        paymentDate: new Date(),
      };

      if (pendingSeasonIndex >= 0) {
        seasonUpdate.registrationDate =
          player.seasons[pendingSeasonIndex].registrationDate;
        player.seasons[pendingSeasonIndex] = seasonUpdate;
      } else {
        seasonUpdate.registrationDate = new Date();
        player.seasons.push(seasonUpdate);
      }

      player.paymentStatus = 'paid';
      player.paymentComplete = true;
      player.markModified('seasons');

      const savedPlayer = await player.save({ session });
      updatedPlayers.push(savedPlayer);

      await Registration.findOneAndUpdate(
        {
          player: player._id,
          season: playerData.season,
          year: playerData.year,
          tryoutId: playerData.tryoutId,
        },
        {
          $set: {
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentId: paymentResult.id,
            amountPaid: perPlayerAmount,
            cardLast4: cardLastFour,
            cardBrand: cardBrand,
            paymentDate: new Date(),
            registrationComplete: true,
          },
        },
        { upsert: true, session },
      );
    }

    const basePaymentData = {
      parentId: parent._id,
      playerCount: players.length,
      playerIds: players.map((p) => p.playerId),
      paymentId: paymentResult.id,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardLastFour,
      cardBrand: cardBrand,
      amount: amount / 100,
      currency: paymentService.settings?.currency || 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      paymentType: 'general',
      idempotencyKey: finalIdempotencyKey,
    };

    const payment = new Payment(
      createPaymentData(paymentService, paymentResult, basePaymentData),
    );
    await payment.save({ session });

    requestTracker.set(requestKey, {
      status: 'completed',
      timestamp: Date.now(),
      paymentId: payment._id,
    });

    try {
      await sendEmail({
        to: buyerEmailAddress,
        subject: 'Payment Confirmation - Bothell Select Basketball',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
            </div>
            <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
              <h1 style="margin: 0;">🎉 Payment Confirmed!</h1>
            </div>
            <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
              <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
              <p style="font-size: 16px;">Thank you for your payment! Your registration has been confirmed.</p>
              <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
                <h3 style="margin-top: 0; color: rgba(0, 0, 0, .7);">Payment Details</h3>
                <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
                <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${amount / 100}</p>
                <p style="margin: 8px 0;"><strong>Payment ID:</strong> ${paymentResult.id}</p>
                <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
                <ul style="margin: 8px 0;">
                  ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
                </ul>
              </div>
              <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
              <p style="font-size: 16px; font-weight: bold;">Thank you for choosing Bothell Select Basketball! 🏀</p>
            </div>
          </div>
        `,
      });
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: payment._id,
      externalPaymentId: paymentResult.id,
      paymentSystem: paymentService.type,
      players: updatedPlayers,
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      message: 'Payment processed successfully',
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment processing error:', error);

    const parentId = req.user?.id;
    if (parentId && req.body.players && req.body.amount) {
      const requestKey = generateRequestKey(
        parentId,
        req.body.amount,
        null,
        req.body.players,
      );
      requestTracker.delete(requestKey);
    }

    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      message: error.message,
    });
  } finally {
    session.endSession();
  }
});

// ============================================
// VERIFY PAYMENT STATUS
// ============================================

router.get('/verify/:paymentId', authenticate, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { paymentSystem } = req.query;

    const paymentRecord = await Payment.findOne({
      $or: [{ paymentId }, { _id: paymentId }],
    });

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found',
      });
    }

    const paymentService = await getPaymentService(
      paymentSystem || paymentRecord.paymentSystem,
    );

    const paymentDetails = await paymentService.getPaymentDetails(paymentId);

    res.json({
      success: true,
      paymentId: paymentDetails.id,
      status: paymentDetails.status,
      amount: paymentDetails.amountMoney?.amount || paymentDetails.amount,
      currency: paymentDetails.amountMoney?.currency || paymentRecord.currency,
      createdAt: paymentDetails.createdAt,
      updatedAt: paymentDetails.updatedAt,
      receiptUrl: paymentDetails.receiptUrl || paymentDetails.receipt_url,
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(400).json({
      success: false,
      message: 'Failed to verify payment status',
    });
  }
});

// ============================================
// WEBHOOKS
// ============================================

router.post('/clover/webhook', express.json(), async (req, res) => {
  try {
    const { type, data, merchantId } = req.body;

    console.log('🔔 Clover webhook received:', {
      type,
      merchantId,
      data: data
        ? {
            paymentId: data.paymentId,
            orderId: data.orderId,
            amount: data.amount,
          }
        : 'No data',
    });

    const config = await getActivePaymentConfig();
    if (!config || config.paymentSystem !== 'clover') {
      console.warn('⚠️ Clover webhook received but Clover is not active');
      return res.status(400).send('Clover not configured');
    }

    if (config.cloverConfig?.merchantId !== merchantId) {
      console.warn('⚠️ Merchant ID mismatch:', {
        received: merchantId,
        configured: config.cloverConfig?.merchantId,
      });
      return res.status(400).send('Invalid merchant ID');
    }

    switch (type) {
      case 'PAYMENT_PAID':
      case 'ORDER_PAID':
        if (data.paymentId) {
          await Payment.findOneAndUpdate(
            { paymentId: data.paymentId },
            {
              $set: {
                status: 'paid',
                processedAt: new Date(),
                updatedAt: new Date(),
              },
            },
          );
          console.log(`✅ Updated payment ${data.paymentId} to paid`);
        }
        break;

      case 'PAYMENT_REFUNDED':
      case 'REFUND_SUCCEEDED':
        if (data.paymentId && data.refundId) {
          await Payment.findOneAndUpdate(
            { paymentId: data.paymentId },
            {
              $set: {
                refundStatus: 'refunded',
                updatedAt: new Date(),
              },
              $push: {
                refunds: {
                  refundId: data.refundId,
                  amount: data.amount ? data.amount / 100 : 0,
                  reason: data.reason || 'Customer request',
                  processedAt: new Date(),
                },
              },
            },
          );
          console.log(`✅ Updated refund for payment ${data.paymentId}`);
        }
        break;

      case 'PAYMENT_FAILED':
        if (data.paymentId) {
          await Payment.findOneAndUpdate(
            { paymentId: data.paymentId },
            {
              $set: {
                status: 'failed',
                updatedAt: new Date(),
              },
            },
          );
          console.log(`⚠️ Updated payment ${data.paymentId} to failed`);
        }
        break;

      default:
        console.log(`ℹ️ Unhandled webhook type: ${type}`);
    }

    res.status(200).json({ success: true, message: 'Webhook processed' });
  } catch (error) {
    console.error('❌ Clover webhook processing error:', error);
    res.status(400).json({
      success: false,
      error: 'Webhook processing failed',
      message: error.message,
    });
  }
});

router.post('/square/webhook', express.json(), async (req, res) => {
  try {
    const body = req.body;

    console.log('🔔 Square webhook received:', {
      type: body?.type,
      eventId: body?.event_id,
    });

    if (body.type === 'payment.created' || body.type === 'payment.updated') {
      const paymentId = body.data?.id;
      const status = body.data?.object?.payment?.status;

      if (paymentId && status) {
        await Payment.findOneAndUpdate(
          { paymentId: paymentId },
          {
            $set: {
              status: status.toLowerCase(),
              updatedAt: new Date(),
            },
          },
        );
        console.log(`✅ Updated Square payment ${paymentId} to ${status}`);
      }
    }

    res.status(200).send('Webhook received');
  } catch (error) {
    console.error('❌ Square webhook error:', error);
    res.status(400).send('Webhook processing failed');
  }
});

// ============================================
// CLOVER RECEIPT
// ============================================

router.get('/clover/receipt/:orderId', authenticate, async (req, res) => {
  try {
    const { orderId } = req.params;

    console.log('🔍 Fetching Clover receipt for orderId:', orderId);

    const payment = await Payment.findOne({
      orderId: orderId,
      paymentSystem: 'clover',
    })
      .populate('playerIds', 'fullName')
      .populate('parentId', 'fullName email');

    if (!payment) {
      console.log('❌ Payment not found for orderId:', orderId);
      return res.status(404).json({
        success: false,
        error: 'Receipt not found',
      });
    }

    if (
      req.user.role !== 'admin' &&
      payment.parentId._id.toString() !== req.user.id
    ) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    res.json({
      success: true,
      receipt: {
        orderId: payment.orderId,
        paymentId: payment.paymentId,
        amount: payment.amount,
        currency: payment.currency,
        date: payment.createdAt,
        status: payment.status,
        cardBrand: payment.cardBrand,
        cardLastFour: payment.cardLastFour,
        buyerEmail: payment.buyerEmail,
        players: payment.playerIds,
        parent: payment.parentId,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching Clover receipt:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
