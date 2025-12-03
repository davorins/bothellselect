// paymentProcessRoutes.js - COMPLETE PAYMENT PROCESSING SOLUTION
const express = require('express');
const { authenticate } = require('../utils/auth');
const Payment = require('../models/Payment');
const { client } = require('../services/square-payments');
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

// PROCESS TOURNAMENT TEAM PAYMENT - MAIN FIX
router.post('/tournament-team', authenticate, async (req, res) => {
  console.log('=== TOURNAMENT PAYMENT REQUEST RECEIVED ===');
  console.log('User ID:', req.user?.id);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('Headers:', req.headers);
  console.log('===========================================');

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
      isAdmin = false,
    } = req.body;

    const parentId = req.user.id;

    console.log('Processing tournament team payment:', {
      teamId,
      tournament,
      year,
      amount,
      parentId,
      email: buyerEmailAddress,
      hasToken: !!token,
      hasSourceId: !!sourceId,
      cardDetails: cardDetails ? 'provided' : 'missing',
    });

    // Validate required fields with specific error messages
    if (!teamId) {
      return res.status(400).json({
        success: false,
        error: 'Team ID is required',
        message: 'No team ID provided in payment request',
      });
    }

    if (!tournament) {
      return res.status(400).json({
        success: false,
        error: 'Tournament name is required',
        message: 'No tournament name provided',
      });
    }

    if (!year) {
      return res.status(400).json({
        success: false,
        error: 'Year is required',
        message: 'No year provided',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
        message: `Invalid amount: ${amount}`,
      });
    }

    if (!token && !sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
        message: 'No payment token or sourceId provided',
      });
    }

    // Check Square configuration
    console.log('Checking Square configuration...');
    if (!process.env.SQUARE_LOCATION_ID) {
      console.error('Square location ID not configured');
      return res.status(500).json({
        success: false,
        error: 'Payment system configuration error',
        message: 'Square location ID not configured',
      });
    }

    if (!process.env.SQUARE_ACCESS_TOKEN) {
      console.error('Square access token not configured');
      return res.status(500).json({
        success: false,
        error: 'Payment system configuration error',
        message: 'Square access token not configured',
      });
    }

    console.log('Square configuration verified:', {
      locationId: process.env.SQUARE_LOCATION_ID ? 'set' : 'missing',
      accessToken: process.env.SQUARE_ACCESS_TOKEN ? 'set' : 'missing',
      environment: process.env.SQUARE_ENVIRONMENT || 'not set',
    });

    // Get team and verify ownership
    console.log('Looking up team:', teamId);
    const team = await Team.findOne({
      _id: teamId,
      coachIds: parentId,
    }).session(session);

    if (!team) {
      console.log('Team not found or unauthorized:', {
        teamId,
        userId: parentId,
        coachIds: team?.coachIds || 'N/A',
      });
      return res.status(404).json({
        success: false,
        error: 'Team not found or unauthorized',
        message: `Team ${teamId} not found or user ${parentId} is not a coach`,
      });
    }

    console.log('Team found:', team.name);

    // Get parent for Square customer
    console.log('Looking up parent:', parentId);
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      console.log('Parent not found:', parentId);
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
        message: `Parent ${parentId} not found`,
      });
    }

    console.log('Parent found:', parent.email);

    // Use existing Square customer ID or create new one
    let customerId = parent.squareCustomerId;
    if (!customerId) {
      console.log('Creating new Square customer for parent:', parent._id);
      try {
        const { result: customerResult } =
          await client.customersApi.createCustomer({
            emailAddress: buyerEmailAddress,
            referenceId: `parent:${parent._id}`,
          });
        customerId = customerResult.customer?.id;
        console.log('Created Square customer:', customerId);

        // Update parent with new customer ID
        await Parent.updateOne(
          { _id: parentId },
          { $set: { squareCustomerId: customerId } },
          { session }
        );
      } catch (squareError) {
        console.error('Error creating Square customer:', squareError);
        const errorDetails = squareError.errors
          ? JSON.stringify(squareError.errors)
          : squareError.message;
        return res.status(400).json({
          success: false,
          error: 'Failed to create Square customer',
          message: `Square customer creation failed: ${errorDetails}`,
        });
      }
    } else {
      console.log('Using existing Square customer:', customerId);
    }

    // Process payment with Square
    const paymentRequest = {
      sourceId: sourceId || token,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: crypto.randomUUID(),
      locationId: process.env.SQUARE_LOCATION_ID,
      customerId,
      referenceId: `t:${teamId.slice(-12)}:${year}`,
      note: `Tournament registration: ${tournament} ${year} - Team: ${team.name}`,
      buyerEmailAddress,
      autocomplete: true,
    };

    console.log('Creating Square payment request:', {
      ...paymentRequest,
      sourceId: paymentRequest.sourceId ? 'present' : 'missing',
      amount: paymentRequest.amountMoney.amount,
      locationId: paymentRequest.locationId,
      customerId: paymentRequest.customerId,
    });

    let paymentResult;
    try {
      console.log('Calling Square Payments API...');
      const { result } = await client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
      console.log('Square payment response:', {
        paymentId: paymentResult.id,
        status: paymentResult.status,
        amount: paymentResult.amountMoney?.amount,
        receiptUrl: paymentResult.receiptUrl,
      });
    } catch (squareError) {
      console.error('Square payment API error:', squareError);
      const errorDetails = squareError.errors
        ? JSON.stringify(squareError.errors)
        : squareError.message;
      console.error('Full Square error details:', errorDetails);

      return res.status(400).json({
        success: false,
        error: 'Square payment failed',
        message: `Payment processing failed: ${errorDetails}`,
        squareErrors: squareError.errors,
      });
    }

    if (!paymentResult) {
      console.error('No payment result received from Square');
      return res.status(400).json({
        success: false,
        error: 'No payment result',
        message: 'Square returned no payment result',
      });
    }

    if (paymentResult.status !== 'COMPLETED') {
      console.error('Payment failed with status:', paymentResult.status);
      return res.status(400).json({
        success: false,
        error: 'Payment not completed',
        message: `Payment status: ${paymentResult.status}`,
        paymentStatus: paymentResult.status,
      });
    }

    console.log('Square payment completed successfully');

    // Validate cardDetails before using them
    if (!cardDetails) {
      console.warn('No card details provided in request');
    }

    // Update team tournament payment status
    const tournamentIndex = team.tournaments.findIndex(
      (t) => t.tournament === tournament && t.year === parseInt(year)
    );

    const tournamentData = {
      tournament: tournament,
      year: parseInt(year),
      paymentStatus: 'paid',
      paymentComplete: true,
      paymentDate: new Date(),
      paymentId: paymentResult.id, // REAL Square payment ID
      cardLast4: cardDetails?.last_4 || 'N/A',
      cardBrand: cardDetails?.card_brand || 'N/A',
      amountPaid: amount / 100,
      levelOfCompetition: team.levelOfCompetition || 'Silver',
    };

    if (tournamentIndex >= 0) {
      // Update existing tournament entry
      team.tournaments[tournamentIndex] = {
        ...team.tournaments[tournamentIndex],
        ...tournamentData,
      };
    } else {
      // Add new tournament entry
      team.tournaments.push(tournamentData);
    }

    // Update top-level team payment status
    team.paymentComplete = true;
    team.paymentStatus = 'paid';
    team.markModified('tournaments');

    await team.save({ session });

    console.log('Team updated with payment:', {
      teamId: team._id,
      tournament: tournament,
      paymentId: paymentResult.id,
    });

    // Update registrations
    const registrationUpdate = await Registration.updateMany(
      {
        team: teamId,
        tournament: tournament,
        year: parseInt(year),
      },
      {
        $set: {
          paymentStatus: 'paid',
          paymentComplete: true,
          paymentDate: new Date(),
          paymentId: paymentResult.id,
          cardLast4: cardDetails?.last_4 || 'N/A',
          cardBrand: cardDetails?.card_brand || 'N/A',
          amountPaid: amount / 100,
          updatedAt: new Date(),
        },
      },
      { session }
    );

    console.log('Registrations updated:', {
      modifiedCount: registrationUpdate.modifiedCount,
    });

    // Create Payment record
    const payment = new Payment({
      parentId: parent._id,
      teamId: teamId,
      paymentId: paymentResult.id,
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails?.last_4 || 'N/A',
      cardBrand: cardDetails?.card_brand || 'N/A',
      cardExpMonth: cardDetails?.exp_month || 0,
      cardExpYear: cardDetails?.exp_year || 0,
      amount: amount / 100,
      currency: 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl,
      note: `Tournament: ${tournament} ${year} - Team: ${team.name}`,
    });

    await payment.save({ session });

    // Send confirmation email
    try {
      await sendTournamentRegistrationEmail(
        parent._id,
        [teamId],
        tournament,
        year,
        amount / 100
      );

      console.log('Tournament confirmation email sent successfully');
    } catch (emailError) {
      console.error(
        'Failed to send tournament confirmation email:',
        emailError
      );
      // Don't fail the payment if email fails
    }

    await session.commitTransaction();
    console.log('Transaction committed successfully');

    res.json({
      success: true,
      paymentId: payment._id,
      squarePaymentId: paymentResult.id,
      team: {
        _id: team._id,
        name: team.name,
        tournaments: team.tournaments,
      },
      payment: {
        paymentId: paymentResult.id,
        amountPaid: amount / 100,
        receiptUrl: paymentResult.receiptUrl,
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

// NEW: PROCESS PAYMENT FOR MULTIPLE TOURNAMENT TEAMS
router.post('/tournament-teams', authenticate, async (req, res) => {
  console.log('=== MULTIPLE TEAMS TOURNAMENT PAYMENT REQUEST RECEIVED ===');
  console.log('User ID:', req.user?.id);
  console.log('Body:', JSON.stringify(req.body, null, 2));
  console.log('===========================================================');

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
    });

    // Validate required fields
    if (!teamIds || !Array.isArray(teamIds) || teamIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Team IDs are required',
        message: 'No team IDs provided in payment request',
      });
    }

    if (!tournament) {
      return res.status(400).json({
        success: false,
        error: 'Tournament name is required',
        message: 'No tournament name provided',
      });
    }

    if (!year) {
      return res.status(400).json({
        success: false,
        error: 'Year is required',
        message: 'No year provided',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
        message: `Invalid amount: ${amount}`,
      });
    }

    if (!token && !sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
        message: 'No payment token or sourceId provided',
      });
    }

    // Check Square configuration
    if (!process.env.SQUARE_LOCATION_ID || !process.env.SQUARE_ACCESS_TOKEN) {
      console.error('Square configuration missing');
      return res.status(500).json({
        success: false,
        error: 'Payment system configuration error',
        message: 'Square configuration missing',
      });
    }

    // Get parent for Square customer
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
        message: `Parent ${parentId} not found`,
      });
    }

    // Use existing Square customer ID or create new one
    let customerId = parent.squareCustomerId;
    if (!customerId) {
      try {
        const { result: customerResult } =
          await client.customersApi.createCustomer({
            emailAddress: buyerEmailAddress,
            referenceId: `parent:${parent._id}`,
          });
        customerId = customerResult.customer?.id;

        await Parent.updateOne(
          { _id: parentId },
          { $set: { squareCustomerId: customerId } },
          { session }
        );
      } catch (squareError) {
        console.error('Error creating Square customer:', squareError);
        return res.status(400).json({
          success: false,
          error: 'Failed to create Square customer',
          message: `Square customer creation failed: ${squareError.message}`,
        });
      }
    }

    // Process payment with Square
    const paymentRequest = {
      sourceId: sourceId || token,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: crypto.randomUUID(),
      locationId: process.env.SQUARE_LOCATION_ID,
      customerId,
      referenceId: `t:${parentId.slice(-12)}:${year}`,
      note: `Tournament registration: ${tournament} ${year} - ${teamIds.length} team(s)`,
      buyerEmailAddress,
      autocomplete: true,
    };

    console.log('Creating Square payment request for multiple teams');

    let paymentResult;
    try {
      const { result } = await client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
      console.log('Square payment response for multiple teams:', {
        paymentId: paymentResult.id,
        status: paymentResult.status,
        amount: paymentResult.amountMoney?.amount,
      });
    } catch (squareError) {
      console.error('Square payment API error:', squareError);
      return res.status(400).json({
        success: false,
        error: 'Square payment failed',
        message: `Payment processing failed: ${squareError.message}`,
        squareErrors: squareError.errors,
      });
    }

    if (!paymentResult || paymentResult.status !== 'COMPLETED') {
      return res.status(400).json({
        success: false,
        error: 'Payment not completed',
        message: `Payment status: ${paymentResult?.status || 'unknown'}`,
        paymentStatus: paymentResult?.status,
      });
    }

    console.log('Square payment completed successfully for multiple teams');

    // Process each team
    const updatedTeams = [];
    const teamCount = teamIds.length;
    const amountPerTeam = amount / 100 / teamCount;
    const invalidTeams = [];

    for (const teamId of teamIds) {
      console.log('Processing team:', teamId);

      // Get team and verify ownership
      const team = await Team.findOne({
        _id: teamId,
        coachIds: parentId,
      }).session(session);

      if (!team) {
        console.log('Team not found or unauthorized:', { teamId, parentId });
        invalidTeams.push(teamId);
        continue;
      }

      // Update team tournament payment status
      const tournamentIndex = team.tournaments.findIndex(
        (t) => t.tournament === tournament && t.year === parseInt(year)
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
        team.tournaments[tournamentIndex] = {
          ...team.tournaments[tournamentIndex],
          ...tournamentData,
        };
      } else {
        team.tournaments.push(tournamentData);
      }

      // Update top-level team payment status if this is the current tournament
      if (
        team.tournament === tournament &&
        team.registrationYear === parseInt(year)
      ) {
        team.paymentComplete = true;
        team.paymentStatus = 'paid';
      }

      team.markModified('tournaments');
      await team.save({ session });
      updatedTeams.push(team);

      // Update registrations for this team
      await Registration.updateMany(
        {
          team: teamId,
          tournament: tournament,
          year: parseInt(year),
          parent: parentId,
        },
        {
          $set: {
            paymentStatus: 'paid',
            paymentComplete: true,
            paymentDate: new Date(),
            paymentId: paymentResult.id,
            cardLast4: cardDetails?.last_4 || 'N/A',
            cardBrand: cardDetails?.card_brand || 'N/A',
            amountPaid: amountPerTeam,
            updatedAt: new Date(),
          },
        },
        { session }
      );
    }

    // Check if any teams were processed
    if (updatedTeams.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        error: 'No teams processed',
        message: `Could not process payment for any teams. Invalid or unauthorized teams: ${invalidTeams.join(', ')}`,
        invalidTeams: invalidTeams,
      });
    }

    // Create Payment record for multiple teams
    const payment = new Payment({
      parentId: parent._id,
      teamIds: updatedTeams.map((team) => team._id),
      paymentId: paymentResult.id,
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails?.last_4 || 'N/A',
      cardBrand: cardDetails?.card_brand || 'N/A',
      cardExpMonth: cardDetails?.exp_month || 0,
      cardExpYear: cardDetails?.exp_year || 0,
      amount: amount / 100,
      currency: 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl,
      note: `Tournament: ${tournament} ${year} - ${teamIds.length} team(s)`,
      metadata: {
        teamCount: teamIds.length,
        tournament,
        year,
        amountPerTeam: amountPerTeam,
      },
    });

    await payment.save({ session });

    // Send confirmation email for multiple teams
    try {
      const teamNames = updatedTeams.map((team) => team.name).join(', ');

      await sendTournamentRegistrationEmail(
        parent._id,
        updatedTeams.map((team) => team._id),
        tournament,
        year,
        amount / 100
      );

      console.log('Tournament confirmation email sent for multiple teams');
    } catch (emailError) {
      console.error(
        'Failed to send tournament confirmation email:',
        emailError
      );
      // Don't fail the payment if email fails
    }

    await session.commitTransaction();
    console.log('Transaction committed successfully for multiple teams');

    res.json({
      success: true,
      paymentId: payment._id,
      squarePaymentId: paymentResult.id,
      teams: updatedTeams.map((team) => ({
        _id: team._id,
        name: team.name,
        tournaments: team.tournaments,
      })),
      payment: {
        paymentId: paymentResult.id,
        amountPaid: amount / 100,
        receiptUrl: paymentResult.receiptUrl,
        status: 'completed',
      },
      message: `Tournament registration payment processed successfully for ${updatedTeams.length} team(s)`,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Multiple teams tournament payment error:', {
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

// FIX MOCK PAYMENTS ENDPOINT
router.post('/fix-mock-payments', authenticate, async (req, res) => {
  try {
    const { teamId, tournament, year } = req.body;

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found',
      });
    }

    // Find and remove mock payment entries
    const tournamentRegistration = team.tournaments.find(
      (t) => t.tournament === tournament && t.year === parseInt(year)
    );

    if (
      tournamentRegistration &&
      tournamentRegistration.paymentId?.startsWith('mock_')
    ) {
      // Reset payment status
      tournamentRegistration.paymentComplete = false;
      tournamentRegistration.paymentStatus = 'pending';
      tournamentRegistration.paymentId = undefined;
      tournamentRegistration.cardBrand = undefined;
      tournamentRegistration.cardLast4 = undefined;
      tournamentRegistration.amountPaid = undefined;

      await team.save();

      return res.json({
        success: true,
        message: 'Payment status reset - team can now complete payment',
        team: team,
      });
    }

    return res.json({
      success: false,
      message: 'No mock payment found to fix',
    });
  } catch (error) {
    console.error('Error fixing mock payment:', error);
    return res.status(500).json({
      success: false,
      message: 'Error fixing payment',
    });
  }
});

// VERIFY PAYMENT STATUS
router.get('/verify/:paymentId', authenticate, async (req, res) => {
  try {
    const { paymentId } = req.params;

    const { paymentsApi } = client;
    const response = await paymentsApi.getPayment(paymentId);

    const payment = response.result.payment;

    res.json({
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amountMoney?.amount,
      currency: payment.amountMoney?.currency,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(400).json({
      success: false,
      message: 'Failed to verify payment status',
    });
  }
});

// EXISTING TRYOUT PAYMENT ENDPOINT (keep as is)
router.post(
  '/tryout',
  authenticate,
  [
    body('token').notEmpty().withMessage('Payment token is required'),
    body('amount')
      .isInt({ min: 1 })
      .withMessage('Amount must be a positive integer'),
    body('currency').isIn(['USD']).withMessage('Currency must be USD'),
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
      .withMessage('Tryout ID is required and must be a string'),
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
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      const errorMessages = errors.array().map((err) => err.msg);
      return res.status(400).json({
        success: false,
        errors: errors.array(),
        message: `Validation failed: ${errorMessages.join(', ')}`,
      });
    }

    const { token, sourceId, amount, currency, email, players, cardDetails } =
      req.body;
    const perPlayerAmount = amount / 100 / players.length;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Log incoming payment data
      console.log('Payment data received:', {
        parentId: req.user.id,
        playerIds: players.map((p) => p.playerId),
        season: players[0]?.season,
        year: players[0]?.year,
        tryoutId: players[0]?.tryoutId,
        amount: amount / 100,
        playerCount: players.length,
      });

      // Verify parent exists
      const parent = await Parent.findById(req.user.id).session(session);
      if (!parent) {
        console.error('Parent not found:', { parentId: req.user.id });
        throw new Error('Parent not found');
      }

      // Process payment with Square
      const paymentRequest = {
        sourceId: sourceId || token,
        amountMoney: {
          amount: parseInt(amount),
          currency: currency,
        },
        idempotencyKey: crypto.randomUUID(),
        locationId: process.env.SQUARE_LOCATION_ID,
        customerId: parent.squareCustomerId,
        referenceId: `parent:${parent._id}`,
        note: `Tryout payment for ${players.length} player(s)`,
        buyerEmailAddress: email,
      };

      console.log('Initiating Square payment:', {
        amount: amount / 100,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
      });

      const paymentResponse =
        await client.paymentsApi.createPayment(paymentRequest);
      const paymentResult = paymentResponse.result.payment;

      if (paymentResult.status !== 'COMPLETED') {
        console.error('Payment failed:', {
          status: paymentResult.status,
          paymentId: paymentResult.id,
        });
        throw new Error(`Payment failed with status: ${paymentResult.status}`);
      }

      // Create Payment record
      const payment = new Payment({
        parentId: parent._id,
        playerCount: players.length,
        playerIds: players.map((p) => p.playerId),
        paymentId: paymentResult.id,
        locationId: process.env.SQUARE_LOCATION_ID,
        buyerEmail: email,
        cardLastFour: cardDetails.last_4 || '',
        cardBrand: cardDetails.card_brand || '',
        cardExpMonth: cardDetails.exp_month,
        cardExpYear: cardDetails.exp_year,
        amount: amount / 100,
        currency,
        status: 'completed',
        processedAt: new Date(),
        receiptUrl: paymentResult.receiptUrl,
        players: players.map((p) => ({
          playerId: p.playerId,
          season: p.season.trim(),
          year: p.year,
          tryoutId: p.tryoutId.trim(),
        })),
      });

      await payment.save({ session });

      // Update all players and their seasons
      const updatedPlayers = [];
      for (const playerData of players) {
        const normalizedSeason = playerData.season.trim();
        const normalizedTryoutId = playerData.tryoutId.trim();

        // Find player by playerId
        let player;
        if (
          playerData.playerId &&
          mongoose.Types.ObjectId.isValid(playerData.playerId)
        ) {
          player = await Player.findOne({
            _id: playerData.playerId,
            parentId: parent._id,
          }).session(session);
        }

        if (!player) {
          console.error('Player not found:', {
            playerId: playerData.playerId,
            parentId: parent._id,
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
          });
          throw new Error(`Player not found for ID: ${playerData.playerId}`);
        }

        console.log('Processing player update:', {
          playerId: player._id,
          fullName: player.fullName,
          existingSeasons: player.seasons.map((s) => ({
            season: s.season,
            year: s.year,
            tryoutId: s.tryoutId,
            paymentStatus: s.paymentStatus,
          })),
          updateData: {
            season: normalizedSeason,
            year: playerData.year,
            tryoutId: normalizedTryoutId,
          },
        });

        // Find matching season
        const seasonIndex = player.seasons.findIndex(
          (s) =>
            s.season.trim().toLowerCase() === normalizedSeason.toLowerCase() &&
            s.year === playerData.year &&
            s.tryoutId.trim().toLowerCase() === normalizedTryoutId.toLowerCase()
        );

        const seasonData = {
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
            seasonIndex >= 0
              ? player.seasons[seasonIndex].registrationDate
              : new Date(),
        };

        if (seasonIndex >= 0) {
          // Update existing season
          player.seasons[seasonIndex] = seasonData;
        } else {
          // Add new season
          player.seasons.push(seasonData);
        }

        // Update top-level player fields
        player.paymentStatus = 'paid';
        player.paymentComplete = true;
        player.registrationComplete = true;
        player.lastPaymentDate = new Date();
        player.markModified('seasons');

        const updatedPlayer = await player.save({ session });
        console.log('Updated player:', {
          playerId: updatedPlayer._id,
          fullName: updatedPlayer.fullName,
          paymentStatus: updatedPlayer.paymentStatus,
          paymentComplete: updatedPlayer.paymentComplete,
          registrationComplete: updatedPlayer.registrationComplete,
          seasons: updatedPlayer.seasons.find(
            (s) =>
              s.season.trim().toLowerCase() ===
                normalizedSeason.toLowerCase() &&
              s.year === playerData.year &&
              s.tryoutId.trim().toLowerCase() ===
                normalizedTryoutId.toLowerCase()
          ),
        });
        updatedPlayers.push(updatedPlayer);

        // Update or create registration
        const registrationUpdate = await Registration.findOneAndUpdate(
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
          { upsert: true, new: true, session }
        );
        console.log('Updated/created registration:', {
          registrationId: registrationUpdate._id,
          playerId: updatedPlayer._id,
          fullName: updatedPlayer.fullName,
          season: normalizedSeason,
          year: playerData.year,
          tryoutId: normalizedTryoutId,
          paymentStatus: registrationUpdate.paymentStatus,
          paymentComplete: registrationUpdate.paymentComplete,
          registrationComplete: registrationUpdate.registrationComplete,
          paymentId: registrationUpdate.paymentId,
          paymentDate: registrationUpdate.paymentDate,
        });
      }

      // Update parent
      const allRegistrations = await Registration.find({
        parent: parent._id,
        season: players[0].season,
        year: players[0].year,
        tryoutId: players[0].tryoutId,
      }).session(session);

      const allPaid = allRegistrations.every(
        (reg) => reg.paymentStatus === 'paid'
      );

      await Parent.findByIdAndUpdate(
        parent._id,
        {
          $set: {
            paymentComplete: allPaid,
            updatedAt: new Date(),
          },
        },
        { session }
      );

      // Send receipt email
      try {
        const playerCount = players.length;
        const totalAmount = amount / 100;
        const perPlayerAmount = 1050;

        await sendEmail({
          to: email,
          subject: 'Payment Confirmation - Bothell Select Basketball',
          html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
        </div>
        
        <div style="background: #1a56db; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">🎉 Payment Confirmed!</h1>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
          <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
          
          <p style="font-size: 16px;">Thank you for your payment! Your registration has been confirmed.</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #1a56db;">
            <h3 style="margin-top: 0; color: #1a56db;">Payment Details</h3>
            <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${playerCount}</p>
            <p style="margin: 8px 0;"><strong>Fee per Player:</strong> $${perPlayerAmount}</p>
            <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${totalAmount}</p>
            <p style="margin: 8px 0;"><strong>Season:</strong> ${players[0]?.season || 'Basketball Select Team'} ${players[0]?.year || new Date().getFullYear()}</p>
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
          
          <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
          
          <p style="font-size: 16px; font-weight: bold;">Welcome to the Bothell Select family! 🏀</p>
        </div>
        
        <div style="background: #e5e7eb; padding: 15px; text-align: center; font-size: 14px; color: #555; border-radius: 0 0 5px 5px;">
          <p style="margin: 0;">Bothell Select Basketball<br>
          bothellselect@proton.me</p>
        </div>
      </div>
    `,
        });

        console.log('Tryout payment confirmation email sent successfully:', {
          parentId: parent._id,
          playerCount,
          totalAmount,
          email: email,
        });
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
      }

      await session.commitTransaction();

      res.status(200).json({
        success: true,
        paymentId: payment._id,
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
        receiptUrl: paymentResult.receiptUrl,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Payment processing error:', {
        message: error.message,
        stack: error.stack,
        requestBody: {
          playerIds: players.map((p) => p.playerId),
          season: players[0]?.season,
          year: players[0]?.year,
          tryoutId: players[0]?.tryoutId,
          amount: amount / 100,
        },
        user: req.user,
      });
      res.status(400).json({
        success: false,
        error: 'Tryout payment processing failed',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    } finally {
      session.endSession();
    }
  }
);

// PROCESS PAYMENTS FOR LOGGED-IN USERS
router.post('/process', authenticate, async (req, res) => {
  console.log('=== PAYMENT PROCESS REQUEST RECEIVED ===');
  console.log('User ID:', req.user?.id);
  console.log('Body:', JSON.stringify(req.body, null, 2));

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
    } = req.body;

    const parentId = req.user.id;

    console.log('Processing payment for logged-in user:', {
      parentId,
      playerCount: players?.length,
      amount,
      email: buyerEmailAddress,
    });

    // Validate required fields
    if (!players || !Array.isArray(players) || players.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Players data is required',
        message: 'No players provided for payment',
      });
    }

    if (!amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Valid payment amount is required',
        message: `Invalid amount: ${amount}`,
      });
    }

    if (!token && !sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Payment token is required',
        message: 'No payment token or sourceId provided',
      });
    }

    // Get parent
    const parent = await Parent.findById(parentId).session(session);
    if (!parent) {
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
        message: `Parent ${parentId} not found`,
      });
    }

    // Use existing Square customer ID or create new one
    let customerId = parent.squareCustomerId;
    if (!customerId) {
      console.log('Creating new Square customer for parent:', parent._id);
      try {
        const { result: customerResult } =
          await client.customersApi.createCustomer({
            emailAddress: buyerEmailAddress,
            referenceId: `parent:${parent._id}`,
          });
        customerId = customerResult.customer?.id;

        // Update parent with new customer ID
        await Parent.updateOne(
          { _id: parentId },
          { $set: { squareCustomerId: customerId } },
          { session }
        );
      } catch (squareError) {
        console.error('Error creating Square customer:', squareError);
        return res.status(400).json({
          success: false,
          error: 'Failed to create Square customer',
          message: `Square customer creation failed: ${squareError.message}`,
        });
      }
    }

    // Process payment with Square
    const paymentRequest = {
      sourceId: sourceId || token,
      amountMoney: {
        amount: parseInt(amount),
        currency: 'USD',
      },
      idempotencyKey: crypto.randomUUID(),
      locationId: process.env.SQUARE_LOCATION_ID,
      customerId,
      referenceId: `parent:${parent._id}`,
      note: `Payment for ${players.length} player(s)`,
      buyerEmailAddress,
      autocomplete: true,
    };

    console.log('Creating Square payment request for logged-in user');

    let paymentResult;
    try {
      const { result } = await client.paymentsApi.createPayment(paymentRequest);
      paymentResult = result.payment;
      console.log('Square payment response:', {
        paymentId: paymentResult.id,
        status: paymentResult.status,
        amount: paymentResult.amountMoney?.amount,
      });
    } catch (squareError) {
      console.error('Square payment API error:', squareError);
      return res.status(400).json({
        success: false,
        error: 'Square payment failed',
        message: `Payment processing failed: ${squareError.message}`,
      });
    }

    if (paymentResult.status !== 'COMPLETED') {
      return res.status(400).json({
        success: false,
        error: 'Payment not completed',
        message: `Payment status: ${paymentResult.status}`,
      });
    }

    console.log('Square payment completed successfully');

    // Update players and registrations
    const perPlayerAmount = amount / 100 / players.length;
    const updatedPlayers = [];

    for (const playerData of players) {
      const player = await Player.findOne({
        _id: playerData.playerId,
        parentId: parent._id,
      }).session(session);

      if (!player) {
        console.error('Player not found:', playerData.playerId);
        continue;
      }

      // Update player season
      const seasonIndex = player.seasons.findIndex(
        (s) =>
          s.season === playerData.season &&
          s.year === playerData.year &&
          s.tryoutId === playerData.tryoutId
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
        registrationDate:
          seasonIndex >= 0
            ? player.seasons[seasonIndex].registrationDate
            : new Date(),
      };

      if (seasonIndex >= 0) {
        player.seasons[seasonIndex] = seasonUpdate;
      } else {
        player.seasons.push(seasonUpdate);
      }

      // Update top-level player fields
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
        { upsert: true, session }
      );
    }

    // Create payment record
    const payment = new Payment({
      parentId: parent._id,
      playerCount: players.length,
      playerIds: players.map((p) => p.playerId),
      paymentId: paymentResult.id,
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmail: buyerEmailAddress,
      cardLastFour: cardDetails?.last_4 || 'N/A',
      cardBrand: cardDetails?.card_brand || 'N/A',
      amount: amount / 100,
      currency: 'USD',
      status: 'completed',
      processedAt: new Date(),
      receiptUrl: paymentResult.receiptUrl,
    });

    await payment.save({ session });

    // Send confirmation email
    try {
      await sendEmail({
        to: buyerEmailAddress,
        subject: 'Payment Confirmation - Bothell Select Basketball',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
            </div>
            
            <div style="background: #1a56db; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
              <h1 style="margin: 0;">🎉 Payment Confirmed!</h1>
            </div>
            
            <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
              <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
              
              <p style="font-size: 16px;">Thank you for your payment! Your registration has been confirmed.</p>
              
              <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #1a56db;">
                <h3 style="margin-top: 0; color: #1a56db;">Payment Details</h3>
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
      console.log('Confirmation email sent successfully');
    } catch (emailError) {
      console.error('Failed to send confirmation email:', emailError);
    }

    await session.commitTransaction();

    res.json({
      success: true,
      paymentId: payment._id,
      squarePaymentId: paymentResult.id,
      players: updatedPlayers,
      receiptUrl: paymentResult.receiptUrl,
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

module.exports = router;
