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

// Helper to get payment service
async function getPaymentService(paymentSystem = null) {
  return await PaymentServiceFactory.getService(paymentSystem);
}

// Helper to get active configuration
async function getActivePaymentConfig() {
  return await PaymentConfiguration.findOne({ isActive: true }).sort({
    isDefault: -1,
    updatedAt: -1,
  });
}

// Helper to validate configuration
function validateConfigForPayment(config, paymentType = 'tournament') {
  console.log('validateConfigForPayment called with:', {
    hasConfig: !!config,
    configId: config?._id,
    paymentSystem: config?.paymentSystem,
    configJSON: JSON.stringify(config, null, 2),
  });

  if (!config) {
    console.error('❌ validateConfigForPayment: No config provided');
    throw new Error('No active payment configuration found');
  }

  const { paymentSystem } = config;
  console.log('Validating payment system:', paymentSystem);

  switch (paymentSystem) {
    case 'square':
      console.log('Square config check:', {
        squareConfig: config.squareConfig,
        accessToken: config.squareConfig?.accessToken,
        locationId: config.squareConfig?.locationId,
      });

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
      console.log('Clover config check:', {
        cloverConfig: config.cloverConfig,
        accessToken: config.cloverConfig?.accessToken,
        merchantId: config.cloverConfig?.merchantId,
      });

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

// Helper to create payment data based on payment system
function createPaymentData(paymentService, paymentResult, baseData) {
  const paymentData = {
    ...baseData,
    paymentSystem: paymentService.type,
    configurationId: paymentService.configurationId,
    // Store system-specific IDs
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

// PROCESS TOURNAMENT TEAM PAYMENT
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
      tournamentId,
      cardDetails,
      cardLastFour,
      cardBrand,
      cardExpMonth,
      cardExpYear,
      tournaments,
      paymentSystem, // Optional: specify payment system
      isAdmin = false,
    } = req.body;

    const parentId = req.user.id;

    console.log('Processing tournament team payment:', {
      teamId,
      tournament,
      year,
      tournamentId,
      amount,
      parentId,
      email: buyerEmailAddress,
      hasToken: !!token,
      hasSourceId: !!sourceId,
      tournamentsCount: tournaments?.length || 0,
      requestedPaymentSystem: paymentSystem,
    });

    // Validate required fields
    if (!teamId) {
      return res.status(400).json({
        success: false,
        error: 'Team ID is required',
      });
    }

    if (!tournament) {
      return res.status(400).json({
        success: false,
        error: 'Tournament name is required',
      });
    }

    if (!year) {
      return res.status(400).json({
        success: false,
        error: 'Year is required',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    if (!token && !sourceId) {
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
      return res.status(404).json({
        success: false,
        error: 'Team not found or unauthorized',
      });
    }

    console.log('Team found:', team.name);

    // Get parent for customer ID
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    console.log('Parent found:', parent.email);

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

        // Update parent with new customer ID
        await Parent.updateOne(
          { _id: parentId },
          { $set: { [customerField]: customerId } },
          { session },
        );
      } catch (customerError) {
        console.error('Error creating customer:', customerError);
        // Continue without customer ID
      }
    }

    // Process payment with the service
    let paymentResult;
    const amountInCents = parseInt(amount);

    if (paymentService.type === 'square') {
      // Square payment
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
        },
        idempotencyKey: crypto.randomUUID(),
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
      });

      const { result } =
        await paymentService.client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
    } else if (paymentService.type === 'clover') {
      // Clover payment
      const paymentData = {
        sourceId: sourceId || token,
        amount: amountInCents,
        email: buyerEmailAddress,
        referenceId: `t:${teamId.slice(-12)}:${year}`,
        note: `Tournament registration: ${tournament} ${year} - Team: ${team.name}`,
      };

      paymentResult = await paymentService.processPayment(paymentData);

      if (!paymentResult.receiptUrl && paymentResult.receipt_url) {
        paymentResult.receiptUrl = paymentResult.receipt_url;
      }
      if (!paymentResult.receiptUrl && paymentResult.id) {
        paymentResult.receiptUrl = `https://www.clover.com/receipt/${paymentResult.id}`;
      }
    }

    if (!paymentResult) {
      throw new Error('No payment result received');
    }

    if (
      paymentResult.status !== 'COMPLETED' &&
      paymentResult.status !== 'PAID'
    ) {
      throw new Error(`Payment failed with status: ${paymentResult.status}`);
    }

    console.log(`${paymentService.type} payment completed successfully:`, {
      paymentId: paymentResult.id,
      status: paymentResult.status,
    });

    // Extract card details
    const cardLast4 = cardDetails?.last_4 || cardLastFour || 'N/A';
    const finalCardBrand = cardDetails?.card_brand || cardBrand || 'N/A';
    const finalCardExpMonth = cardDetails?.exp_month || cardExpMonth || '0';
    const finalCardExpYear = cardDetails?.exp_year || cardExpYear || '0';

    // Prepare tournament data
    const tournamentData = {
      tournamentId: new mongoose.Types.ObjectId(tournamentId),
      tournamentName: tournament,
      year: parseInt(year),
      registrationDate: new Date(),
      paymentStatus: 'paid',
      paymentComplete: true,
      amountPaid: amount / 100,
      paymentId: paymentResult.id,
      paymentMethod: 'card',
      cardLast4: cardLast4,
      cardBrand: finalCardBrand,
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

    // Create Payment record using helper
    const basePaymentData = {
      parentId: parent._id,
      teamId: teamId,
      paymentId: paymentResult.id,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardLast4,
      cardBrand: finalCardBrand,
      cardExpMonth: finalCardExpMonth,
      cardExpYear: finalCardExpYear,
      amount: amount / 100,
      currency: paymentService.settings?.currency || 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      note: `Tournament: ${tournament} ${year} - Team: ${team.name}`,
      tournamentName: tournament,
      year: parseInt(year),
      paymentType: 'tournament',
    };

    const payment = new Payment(
      createPaymentData(paymentService, paymentResult, basePaymentData),
    );
    await payment.save({ session });

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

// MULTIPLE TOURNAMENT TEAMS PAYMENT - UPDATED
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
      paymentSystem, // Optional: specify payment system
      isAdmin = false,
    } = req.body;

    const parentId = req.user.id;

    console.log('Processing multiple teams tournament payment:', {
      teamIds,
      tournament,
      year,
      amount,
      parentId,
      email: buyerEmailAddress,
      hasToken: !!token,
      hasSourceId: !!sourceId,
      teamCount: teamIds?.length || 0,
      requestedPaymentSystem: paymentSystem,
    });

    // Validate required fields
    if (!teamIds || !Array.isArray(teamIds) || teamIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Team IDs are required',
      });
    }

    if (!tournament) {
      return res.status(400).json({
        success: false,
        error: 'Tournament name is required',
      });
    }

    if (!year) {
      return res.status(400).json({
        success: false,
        error: 'Year is required',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    if (!token && !sourceId) {
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
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    // Use existing customer ID or create new one
    let customerId;
    const customerField = `${paymentService.type}CustomerId`;
    customerId = parent[customerField];

    // Process payment
    let paymentResult;
    const amountInCents = parseInt(amount);

    if (paymentService.type === 'square') {
      // Square payment for multiple teams
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
        },
        idempotencyKey: crypto.randomUUID(),
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
      // Clover payment for multiple teams
      const paymentData = {
        sourceId: sourceId || token,
        amount: amountInCents,
        email: buyerEmailAddress,
        referenceId: `t:${parentId.slice(-12)}:${year}`,
        note: `Tournament registration: ${tournament} ${year} - ${teamIds.length} team(s)`,
      };

      paymentResult = await paymentService.processPayment(paymentData);

      if (!paymentResult.receiptUrl && paymentResult.receipt_url) {
        paymentResult.receiptUrl = paymentResult.receipt_url;
      }
      if (!paymentResult.receiptUrl && paymentResult.id) {
        paymentResult.receiptUrl = `https://www.clover.com/receipt/${paymentResult.id}`;
      }
    }

    if (
      !paymentResult ||
      (paymentResult.status !== 'COMPLETED' && paymentResult.status !== 'PAID')
    ) {
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
        cardLast4: cardDetails?.last_4 || 'N/A',
        cardBrand: cardDetails?.card_brand || 'N/A',
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
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No teams processed',
        invalidTeams: invalidTeams,
      });
    }

    // Create Payment record using helper
    const basePaymentData = {
      parentId: parent._id,
      teamIds: updatedTeams.map((team) => team._id),
      paymentId: paymentResult.id,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails?.last_4 || 'N/A',
      cardBrand: cardDetails?.card_brand || 'N/A',
      cardExpMonth: cardDetails?.exp_month || 0,
      cardExpYear: cardDetails?.exp_year || 0,
      amount: amount / 100,
      currency: paymentService.settings?.currency || 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      note: `Tournament: ${tournament} ${year} - ${teamIds.length} team(s)`,
      tournamentName: tournament,
      year: parseInt(year),
      paymentType: 'tournament',
      metadata: {
        teamCount: teamIds.length,
        tournament,
        year,
        amountPerTeam: amountPerTeam,
      },
    };

    const payment = new Payment(
      createPaymentData(paymentService, paymentResult, basePaymentData),
    );
    await payment.save({ session });

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
    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      message: error.message,
    });
  } finally {
    session.endSession();
  }
});

// TRYOUT PAYMENT ENDPOINT
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
  ],
  async (req, res) => {
    console.log('🔍 DEBUG Tryout payment request:', {
      bodyKeys: Object.keys(req.body),
      hasToken: !!req.body.token,
      hasSourceId: !!req.body.sourceId,
      amount: req.body.amount,
      email: req.body.email,
      playersCount: req.body.players?.length || 0,
      players: req.body.players?.map((p) => ({
        playerId: p.playerId,
        playerIdIsValid: mongoose.Types.ObjectId.isValid(p.playerId || ''),
        season: p.season,
        year: p.year,
        tryoutId: p.tryoutId,
        tryoutIdLength: p.tryoutId?.length || 0,
      })),
      cardDetails: req.body.cardDetails
        ? {
            last_4: req.body.cardDetails.last_4,
            last_4Length: req.body.cardDetails.last_4?.length || 0,
            card_brand: req.body.cardDetails.card_brand,
            exp_month: req.body.cardDetails.exp_month,
            exp_year: req.body.cardDetails.exp_year,
            currentYear: new Date().getFullYear(),
            expYearValid:
              req.body.cardDetails.exp_year >= new Date().getFullYear(),
          }
        : 'No cardDetails',
      paymentSystem: req.body.paymentSystem,
      user: req.user?.id,
    });

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
        debug: {
          receivedPlayers: req.body.players?.map((p) => ({
            playerId: p.playerId,
            season: p.season,
            year: p.year,
            tryoutId: p.tryoutId,
          })),
          receivedCardDetails: req.body.cardDetails,
        },
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
    } = req.body;
    const perPlayerAmount = amount / 100 / players.length;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('✅ Validation passed, processing tryout payment:', {
        parentId: req.user.id,
        playerIds: players.map((p) => p.playerId),
        season: players[0]?.season,
        year: players[0]?.year,
        tryoutId: players[0]?.tryoutId,
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
        throw new Error('Parent not found');
      }

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
          idempotencyKey: crypto.randomUUID(),
          locationId: paymentService.config.locationId,
          customerId: parent.squareCustomerId,
          referenceId: `parent:${parent._id}`,
          note: `Tryout payment for ${players.length} player(s)`,
          buyerEmailAddress: email,
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

        if (!paymentResult.receiptUrl && paymentResult.receipt_url) {
          paymentResult.receiptUrl = paymentResult.receipt_url;
        }
        if (!paymentResult.receiptUrl && paymentResult.id) {
          paymentResult.receiptUrl = `https://www.clover.com/receipt/${paymentResult.id}`;
        }
      }

      if (
        !paymentResult ||
        (paymentResult.status !== 'COMPLETED' &&
          paymentResult.status !== 'PAID')
      ) {
        throw new Error(`Payment failed with status: ${paymentResult?.status}`);
      }

      // Create Payment record using helper
      const basePaymentData = {
        parentId: parent._id,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
        paymentId: paymentResult.id,
        buyerEmail: email,
        cardLastFour: cardDetails.last_4 || '',
        cardBrand: cardDetails.card_brand || '',
        cardExpMonth: cardDetails.exp_month,
        cardExpYear: cardDetails.exp_year,
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

        const player = await Player.findOne({
          _id: playerData.playerId,
          parentId: parent._id,
        }).session(session);

        if (!player) {
          throw new Error(`Player not found for ID: ${playerData.playerId}`);
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
            cardLast4: cardDetails.last_4 || '',
            cardBrand: cardDetails.card_brand || '',
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
            cardLast4: cardDetails.last_4 || '',
            cardBrand: cardDetails.card_brand || '',
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
              cardLast4: cardDetails.last_4 || '',
              cardBrand: cardDetails.card_brand || '',
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

      // Send receipt email
      try {
        await sendEmail({
          to: email,
          subject: 'Payment Confirmation - Partizan Basketball',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <img src="https://partizanhoops.com/assets/img/logo.png" alt="Partizan Basketball" style="max-width: 200px; height: auto;">
              </div>
              <div style="background: #594230; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
                <h1 style="margin: 0;">🎉 Payment Confirmed!</h1>
              </div>
              <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
                <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
                <p style="font-size: 16px;">Thank you for your payment! Your registration has been confirmed.</p>
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #594230;">
                  <h3 style="margin-top: 0; color: #594230;">Payment Details</h3>
                  <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
                  <p style="margin: 8px 0;"><strong>Fee per Player:</strong> $${perPlayerAmount}</p>
                  <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${amount / 100}</p>
                  <p style="margin: 8px 0;"><strong>Season:</strong> ${players[0]?.season || 'Partizan Team'} ${players[0]?.year || new Date().getFullYear()}</p>
                  <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
                  <ul style="margin: 8px 0;">
                    ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
                  </ul>
                </div>
                <p style="font-size: 16px;"><strong>What's Next?</strong></p>
                <ul style="font-size: 14px;">
                  <li>You will receive team assignment and practice schedule information within the next week</li>
                  <li>Look out for welcome materials from your coach</li>
                  <li>Practice schedules will be shared via email and the team portal</li>
                </ul>
                <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at partizanhoops@proton.me</p>
                <p style="font-size: 16px; font-weight: bold;">Welcome to the Partizan family! 🏀</p>
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

// TRAINING PAYMENT ENDPOINT - UPDATED
router.post(
  '/training',
  authenticate,
  [
    // Payment token validation
    body('token')
      .optional() // Make token optional since sourceId might be used
      .notEmpty()
      .withMessage('Payment token is required if sourceId is not provided'),
    body('sourceId')
      .optional()
      .notEmpty()
      .withMessage('Payment sourceId is required if token is not provided'),

    // Validate at least one payment method exists
    body().custom((value, { req }) => {
      if (!req.body.token && !req.body.sourceId) {
        throw new Error('Either token or sourceId must be provided');
      }
      return true;
    }),

    // Amount validation
    body('amount')
      .isInt({ min: 1 })
      .withMessage('Amount must be a positive integer'),

    // Email validation
    body('email').isEmail().withMessage('Valid email is required'),

    // Players validation
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
      .optional() // Make tryoutId optional for training
      .isString()
      .withMessage('Tryout ID must be a string'),

    // Card details validation - make it optional to match frontend
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

    // Payment system validation
    body('paymentSystem')
      .optional()
      .isIn(['square', 'clover'])
      .withMessage('Payment system must be square or clover'),
  ],
  async (req, res) => {
    console.log('🔍 DEBUG Training payment request received:', {
      bodyKeys: Object.keys(req.body),
      hasToken: !!req.body.token,
      hasSourceId: !!req.body.sourceId,
      amount: req.body.amount,
      email: req.body.email,
      playersCount: req.body.players?.length || 0,
      players: req.body.players?.map((p) => ({
        playerId: p.playerId,
        season: p.season,
        year: p.year,
        tryoutId: p.tryoutId,
      })),
      cardDetails: req.body.cardDetails,
      paymentSystem: req.body.paymentSystem,
      user: req.user?.id,
    });

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
        debug: {
          receivedBody: {
            amount: req.body.amount,
            email: req.body.email,
            token: req.body.token ? 'Provided' : 'Missing',
            sourceId: req.body.sourceId ? 'Provided' : 'Missing',
            players: req.body.players,
            cardDetails: req.body.cardDetails,
          },
        },
      });
    }

    const {
      token,
      sourceId,
      amount,
      email,
      players,
      cardDetails = {}, // Default to empty object
      paymentSystem,
    } = req.body;

    // Calculate per player amount
    const perPlayerAmount = amount / 100 / players.length;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      console.log('✅ Training payment validation passed, processing...');

      // Get payment service
      const paymentService = await getPaymentService(paymentSystem);
      console.log('Using payment service for training:', paymentService.type);

      // Validate configuration
      validateConfigForPayment(paymentService.configuration, 'training');

      // Verify parent exists
      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        throw new Error('Parent not found');
      }

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
          idempotencyKey: crypto.randomUUID(),
          locationId: paymentService.config.locationId,
          customerId: parent.squareCustomerId,
          referenceId: `training:${parent._id}:${Date.now()}`,
          note: `Training payment for ${players.length} player(s)`,
          buyerEmailAddress: email,
          autocomplete: true,
        };

        console.log('Square payment request:', {
          locationId: paymentService.config.locationId,
          amount: amountInCents,
          referenceId: paymentRequest.referenceId,
        });

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

        console.log('Clover payment request:', paymentData);
        paymentResult = await paymentService.processPayment(paymentData);

        if (!paymentResult.receiptUrl && paymentResult.receipt_url) {
          paymentResult.receiptUrl = paymentResult.receipt_url;
        }
        if (!paymentResult.receiptUrl && paymentResult.id) {
          paymentResult.receiptUrl = `https://www.clover.com/receipt/${paymentResult.id}`;
        }
      }

      if (
        !paymentResult ||
        (paymentResult.status !== 'COMPLETED' &&
          paymentResult.status !== 'PAID')
      ) {
        console.error('Payment failed:', paymentResult);
        throw new Error(`Payment failed with status: ${paymentResult?.status}`);
      }

      console.log(`${paymentService.type} payment successful:`, {
        paymentId: paymentResult.id,
        status: paymentResult.status,
      });

      // Create Payment record using helper
      const basePaymentData = {
        parentId: parent._id,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
        paymentId: paymentResult.id,
        buyerEmail: email,
        cardLastFour: cardDetails?.last_4 || '',
        cardBrand: cardDetails?.card_brand || '',
        cardExpMonth: cardDetails?.exp_month || 0,
        cardExpYear: cardDetails?.exp_year || 0,
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
      };

      const payment = new Payment(
        createPaymentData(paymentService, paymentResult, basePaymentData),
      );
      await payment.save({ session });

      // Update all players and their seasons for training
      const updatedPlayers = [];
      for (const playerData of players) {
        const normalizedSeason = playerData.season.trim();
        const normalizedTryoutId = playerData.tryoutId?.trim() || 'training';

        const player = await Player.findOne({
          _id: playerData.playerId,
          parentId: parent._id,
        }).session(session);

        if (!player) {
          throw new Error(`Player not found for ID: ${playerData.playerId}`);
        }

        // Check for pending training seasons
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
            cardLast4: cardDetails?.last_4 || '',
            cardBrand: cardDetails?.card_brand || '',
            paymentDate: new Date(),
            registrationDate:
              player.seasons[pendingTrainingSeasonIndex].registrationDate ||
              new Date(),
          };
        } else {
          // Add new training season
          player.seasons.push({
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentId: paymentResult.id,
            amountPaid: perPlayerAmount,
            cardLast4: cardDetails?.last_4 || '',
            cardBrand: cardDetails?.card_brand || '',
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
              cardLast4: cardDetails?.last_4 || '',
              cardBrand: cardDetails?.card_brand || '',
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

      // Send training confirmation email
      try {
        await sendEmail({
          to: email,
          subject: 'Training Payment Confirmation - Partizan Basketball',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
              <div style="text-align: center; margin-bottom: 20px;">
                <img src="https://partizanhoops.com/assets/img/logo.png" alt="Partizan Basketball" style="max-width: 200px; height: auto;">
              </div>
              <div style="background: #594230; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
                <h1 style="margin: 0;">🏀 Training Payment Confirmed!</h1>
              </div>
              <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
                <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
                <p style="font-size: 16px;">Thank you for your training payment! Your registration has been confirmed.</p>
                <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #594230;">
                  <h3 style="margin-top: 0; color: #594230;">Training Payment Details</h3>
                  <p style="margin: 8px 0;"><strong>Training Program:</strong> ${players[0]?.season || 'Basketball Training'}</p>
                  <p style="margin: 8px 0;"><strong>Year:</strong> ${players[0]?.year || new Date().getFullYear()}</p>
                  <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
                  <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${amount / 100}</p>
                  <p style="margin: 8px 0;"><strong>Payment ID:</strong> ${paymentResult.id}</p>
                  <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
                  <ul style="margin: 8px 0;">
                    ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
                  </ul>
                </div>
                <p style="font-size: 16px;"><strong>Training Information:</strong></p>
                <ul style="font-size: 14px;">
                  <li>You will receive training schedule information within the next week</li>
                  <li>Training sessions will focus on skill development and fundamentals</li>
                  <li>Please arrive 15 minutes early for your first session</li>
                  <li>Bring basketball shoes, water bottle, and appropriate workout attire</li>
                </ul>
                <p style="font-size: 14px; color: #555;">If you have any questions about the training program, please contact us at partizanhoops@proton.me</p>
                <p style="font-size: 16px; font-weight: bold;">We look forward to training with you! 🏀</p>
              </div>
            </div>
          `,
        });
        console.log('✅ Training confirmation email sent');
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

// PROCESS PAYMENTS FOR LOGGED-IN USERS - UPDATED
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
      paymentSystem, // Optional: specify payment system
    } = req.body;

    const parentId = req.user.id;

    console.log('Processing payment for logged-in user:', {
      parentId,
      playerCount: players?.length,
      amount,
      email: buyerEmailAddress,
      requestedPaymentSystem: paymentSystem,
    });

    // Validate required fields
    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Players data is required',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    if (!token && !sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
      });
    }

    // Get payment service
    const paymentService = await getPaymentService(paymentSystem);
    console.log(
      'Using payment service for general payment:',
      paymentService.type,
    );

    // Validate configuration
    validateConfigForPayment(paymentService.configuration, 'general');

    // Get parent
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    // Use existing customer ID
    let customerId;
    const customerField = `${paymentService.type}CustomerId`;
    customerId = parent[customerField];

    // Process payment
    let paymentResult;
    const amountInCents = parseInt(amount);
    const perPlayerAmount = amount / 100 / players.length;

    if (paymentService.type === 'square') {
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: amountInCents,
          currency: paymentService.settings?.currency || 'USD',
        },
        idempotencyKey: crypto.randomUUID(),
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

      if (!paymentResult.receiptUrl && paymentResult.receipt_url) {
        paymentResult.receiptUrl = paymentResult.receipt_url;
      }
      if (!paymentResult.receiptUrl && paymentResult.id) {
        paymentResult.receiptUrl = `https://www.clover.com/receipt/${paymentResult.id}`;
      }
    }

    if (
      !paymentResult ||
      (paymentResult.status !== 'COMPLETED' && paymentResult.status !== 'PAID')
    ) {
      throw new Error(`Payment failed with status: ${paymentResult?.status}`);
    }

    console.log(`${paymentService.type} payment completed successfully`);

    // Update players and registrations
    const updatedPlayers = [];

    for (const playerData of players) {
      const player = await Player.findOne({
        _id: playerData.playerId,
        parentId: parent._id,
      }).session(session);

      if (!player) {
        continue;
      }

      // Check for pending season
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
        cardLast4: cardDetails?.last_4 || 'N/A',
        cardBrand: cardDetails?.card_brand || 'N/A',
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

      // Update registration
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
            cardLast4: cardDetails?.last_4 || 'N/A',
            cardBrand: cardDetails?.card_brand || 'N/A',
            paymentDate: new Date(),
            registrationComplete: true,
          },
        },
        { upsert: true, session },
      );
    }

    // Create payment record using helper
    const basePaymentData = {
      parentId: parent._id,
      playerCount: players.length,
      playerIds: players.map((p) => p.playerId),
      paymentId: paymentResult.id,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails?.last_4 || 'N/A',
      cardBrand: cardDetails?.card_brand || 'N/A',
      amount: amount / 100,
      currency: paymentService.settings?.currency || 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl || paymentResult.receipt_url,
      paymentType: 'general',
    };

    const payment = new Payment(
      createPaymentData(paymentService, paymentResult, basePaymentData),
    );
    await payment.save({ session });

    // Send confirmation email
    try {
      await sendEmail({
        to: buyerEmailAddress,
        subject: 'Payment Confirmation - Partizan Basketball',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="https://partizanhoops.com/assets/img/logo.png" alt="Partizan Basketball" style="max-width: 200px; height: auto;">
            </div>
            <div style="background: #594230; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
              <h1 style="margin: 0;">🎉 Payment Confirmed!</h1>
            </div>
            <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
              <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
              <p style="font-size: 16px;">Thank you for your payment! Your registration has been confirmed.</p>
              <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #594230;">
                <h3 style="margin-top: 0; color: #594230;">Payment Details</h3>
                <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
                <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${amount / 100}</p>
                <p style="margin: 8px 0;"><strong>Payment ID:</strong> ${paymentResult.id}</p>
                <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
                <ul style="margin: 8px 0;">
                  ${updatedPlayers.map((p) => `<li>${p.fullName}</li>`).join('')}
                </ul>
              </div>
              <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at partizanhoops@proton.me</p>
              <p style="font-size: 16px; font-weight: bold;">Thank you for choosing Partizan Basketball! 🏀</p>
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
    res.status(400).json({
      success: false,
      error: 'Payment processing failed',
      message: error.message,
    });
  } finally {
    session.endSession();
  }
});

// VERIFY PAYMENT STATUS
router.get('/verify/:paymentId', authenticate, async (req, res) => {
  try {
    const { paymentId } = req.params;
    const { paymentSystem } = req.query;

    // Get payment record from database
    const paymentRecord = await Payment.findOne({
      $or: [{ paymentId }, { _id: paymentId }],
    });

    if (!paymentRecord) {
      return res.status(404).json({
        success: false,
        message: 'Payment record not found',
      });
    }

    // Get payment service
    const paymentService = await getPaymentService(
      paymentSystem || paymentRecord.paymentSystem,
    );

    // Get payment details from payment processor
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

    // Validate merchant ID matches your configuration
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

    // Handle different webhook events
    switch (type) {
      case 'PAYMENT_PAID':
      case 'ORDER_PAID':
        // Update payment status to paid
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
        // Handle refunds
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
        // Update payment status to failed
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
    const signature = req.headers['x-square-signature'];
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

router.post('/clover/process', authenticate, async (req, res) => {
  console.log('=== CLOVER PAYMENT PROCESS REQUEST ===');

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
      registrationType,
      teamIds,
      tournament,
      year,
      tournamentId,
    } = req.body;

    const parentId = req.user.id;

    console.log('Processing Clover payment:', {
      parentId,
      registrationType,
      amount,
      email: buyerEmailAddress,
      playerCount: players?.length || 0,
      teamCount: teamIds?.length || 0,
    });

    // Validate required fields
    if (!token && !sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
      });
    }

    // Get Clover payment service
    const paymentService = await getPaymentService('clover');
    console.log('Using Clover payment service');

    // Validate configuration
    validateConfigForPayment(paymentService.configuration, registrationType);

    // Get parent
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
      });
    }

    // Process Clover payment
    const amountInCents = parseInt(amount);
    const paymentData = {
      sourceId: sourceId || token,
      amount: amountInCents,
      email: buyerEmailAddress,
      referenceId: `parent:${parent._id}`,
      note: `${registrationType} payment`,
    };

    const paymentResult = await paymentService.processPayment(paymentData);

    if (
      paymentResult.status !== 'PAID' &&
      paymentResult.status !== 'AUTHORIZED'
    ) {
      throw new Error(
        `Clover payment failed with status: ${paymentResult.status}`,
      );
    }

    console.log('✅ Clover payment completed:', {
      paymentId: paymentResult.id,
      status: paymentResult.status,
    });

    // Handle different registration types
    let responseData = { success: true };

    if (registrationType === 'tryout') {
      // Handle tryout registration
      // ... (copy tryout logic from existing endpoint)
    } else if (registrationType === 'training') {
      // Handle training registration
      // ... (copy training logic from existing endpoint)
    } else if (registrationType === 'tournament') {
      // Handle tournament registration
      // ... (copy tournament logic from existing endpoint)
    } else {
      // Handle general payment
      // ... (copy general payment logic)
    }

    await session.commitTransaction();
    res.json(responseData);
  } catch (error) {
    await session.abortTransaction();
    console.error('Clover payment error:', error);
    res.status(400).json({
      success: false,
      error: 'Clover payment processing failed',
      message: error.message,
    });
  } finally {
    session.endSession();
  }
});

module.exports = router;
