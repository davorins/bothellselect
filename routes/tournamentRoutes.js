// tournamentRoutes.js
const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');

// Import models
const Tournament = require('../models/Tournament');
const Team = require('../models/Team');
const Match = require('../models/Match');

// Import controller
const tournamentController = require('../controllers/tournamentController');

// Import middleware
const { requireAuth, requireAdmin } = require('../middleware/auth');

// Import utility functions
const tournamentUtils = require('../utils/tournamentUtils');

// Validation middleware
const validateTournament = [
  body('name').trim().notEmpty().withMessage('Tournament name is required'),
  body('year')
    .isInt({ min: 2020, max: 2030 })
    .withMessage('Valid year is required'),
  body('startDate').isISO8601().withMessage('Valid start date is required'),
  body('endDate').isISO8601().withMessage('Valid end date is required'),
  body('levelOfCompetition')
    .isIn(['Gold', 'Silver', 'All'])
    .withMessage('Valid competition level is required'),
  body('sex')
    .isIn(['Male', 'Female', 'Mixed'])
    .withMessage('Valid gender is required'),
  body('format')
    .isIn([
      'single-elimination',
      'double-elimination',
      'round-robin',
      'group-stage',
    ])
    .withMessage('Valid format is required'),
  body('maxTeams')
    .optional()
    .isInt({ min: 2 })
    .withMessage('Max teams must be at least 2'),
  body('minTeams')
    .optional()
    .isInt({ min: 2 })
    .withMessage('Min teams must be at least 2'),
];

const validateMatchUpdate = [
  body('team1Score')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Team 1 score must be a positive integer'),
  body('team2Score')
    .optional()
    .isInt({ min: 0 })
    .withMessage('Team 2 score must be a positive integer'),
  body('status')
    .optional()
    .isIn([
      'scheduled',
      'in-progress',
      'completed',
      'cancelled',
      'walkover',
      'bye',
    ])
    .withMessage('Invalid status'),
  body('winner')
    .optional()
    .isMongoId()
    .withMessage('Valid winner ID is required'),
];

// ============================================
// SPECIAL ROUTES (MUST COME BEFORE /:id ROUTE)
// ============================================

// Get tournaments extracted from teams
router.get('/from-teams', requireAuth, async (req, res) => {
  try {
    console.log('📋 Fetching tournaments from teams collection...');

    const tournaments = await tournamentUtils.extractTournamentsFromTeams();

    res.json({
      success: true,
      tournaments,
      count: tournaments.length,
    });
  } catch (error) {
    console.error('Error fetching tournaments from teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournaments from teams',
      error: error.message,
    });
  }
});

// Create tournament from teams
router.post(
  '/create-from-teams',
  requireAuth,
  requireAdmin,
  [
    body('name').trim().notEmpty().withMessage('Tournament name is required'),
    body('year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Valid year is required'),
  ],
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { name, year } = req.body;
      const userId = req.user.id;

      console.log(`🎯 Creating tournament from teams: ${name} ${year}`);

      const result = await tournamentUtils.createOrUpdateTournamentFromTeams(
        name,
        year,
        userId
      );

      res.json({
        success: true,
        message: 'Tournament created successfully from teams',
        tournament: result.tournament,
        teams: result.teams,
        teamCount: result.teamCount,
      });
    } catch (error) {
      console.error('Error creating tournament from teams:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to create tournament from teams',
        error: error.message,
      });
    }
  }
);

// Get tournament by name and year (for teams collection)
router.get(
  '/by-name/:name/:year',
  requireAuth,
  [
    param('name').notEmpty().withMessage('Tournament name is required'),
    param('year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Valid year is required'),
  ],
  async (req, res) => {
    try {
      const { name, year } = req.params;

      console.log(`🔍 Looking for tournament: ${name} ${year}`);

      // First, check if tournament exists in database
      const existingTournament = await Tournament.findOne({
        name: decodeURIComponent(name),
        year: parseInt(year),
      })
        .populate(
          'registeredTeams',
          'name grade sex levelOfCompetition tournament tournaments'
        )
        .lean();

      if (existingTournament) {
        return res.json({
          success: true,
          tournament: existingTournament,
          source: 'database',
        });
      }

      // If not in database, get from teams collection
      const teams = await tournamentUtils.getTeamsForTournament(
        decodeURIComponent(name),
        parseInt(year)
      );

      if (teams.length === 0) {
        return res.status(404).json({
          success: false,
          message: `No teams found for tournament: ${decodeURIComponent(name)} ${year}`,
        });
      }

      // Determine tournament metadata
      const levels = [...new Set(teams.map((t) => t.levelOfCompetition))];
      const levelOfCompetition =
        levels.length === 1
          ? levels[0]
          : levels.includes('Gold')
            ? 'Gold'
            : 'All';

      const genders = [...new Set(teams.map((t) => t.sex))];
      const sex =
        genders.length === 1
          ? genders[0]
          : genders.includes('Male') && genders.includes('Female')
            ? 'Mixed'
            : genders[0] || 'Mixed';

      const tournamentFromTeams = {
        name: decodeURIComponent(name),
        year: parseInt(year),
        teams,
        teamCount: teams.length,
        levelOfCompetition,
        sex,
        status: 'extracted',
        description: `${decodeURIComponent(name)} ${year} - Extracted from team registrations`,
        maxTeams: Math.max(16, Math.pow(2, Math.ceil(Math.log2(teams.length)))),
        minTeams: Math.min(4, teams.length),
      };

      res.json({
        success: true,
        tournament: tournamentFromTeams,
        source: 'teams_collection',
      });
    } catch (error) {
      console.error('Error getting tournament by name:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get tournament',
        error: error.message,
      });
    }
  }
);

// Get teams for a specific tournament (from teams collection)
router.get(
  '/:name/:year/teams-from-collection',
  requireAuth,
  [
    param('name').notEmpty().withMessage('Tournament name is required'),
    param('year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Valid year is required'),
  ],
  async (req, res) => {
    try {
      const { name, year } = req.params;

      const teams = await tournamentUtils.getTeamsForTournament(
        decodeURIComponent(name),
        parseInt(year)
      );

      res.json({
        success: true,
        teams,
        count: teams.length,
      });
    } catch (error) {
      console.error('Error getting teams from collection:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get teams from collection',
        error: error.message,
      });
    }
  }
);

// ============================================
// REGULAR ROUTES (AFTER SPECIAL ROUTES)
// ============================================

// Tournament CRUD operations
router.post(
  '/',
  requireAuth,
  requireAdmin,
  validateTournament,
  tournamentController.createTournament
);

router.get('/', requireAuth, tournamentController.getTournaments);

// IMPORTANT: This /:id route must come AFTER all special routes
router.get(
  '/:id',
  requireAuth,
  [param('id').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.getTournament
);

router.put(
  '/:id',
  requireAuth,
  requireAdmin,
  [param('id').isMongoId().withMessage('Invalid tournament ID')],
  validateTournament,
  tournamentController.updateTournament
);

router.delete(
  '/:id',
  requireAuth,
  requireAdmin,
  [param('id').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.deleteTournament
);

// Team management
router.post(
  '/:tournamentId/teams/:teamId',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('teamId').isMongoId().withMessage('Invalid team ID'),
  ],
  tournamentController.addTeamToTournament
);

router.delete(
  '/:tournamentId/teams/:teamId',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('teamId').isMongoId().withMessage('Invalid team ID'),
  ],
  tournamentController.removeTeamFromTournament
);

// Get registered teams for a tournament
router.get(
  '/:tournamentId/registered-teams',
  requireAuth,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.getRegisteredTeams
);

// Get eligible teams (teams that can be added to tournament)
router.get(
  '/:tournamentId/eligible-teams',
  requireAuth,
  requireAdmin,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.getEligibleTeams
);

// Batch add teams
router.post(
  '/:tournamentId/teams/batch',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('teamIds').isArray().withMessage('Team IDs must be an array'),
  ],
  tournamentController.addTeamsToTournamentBatch
);

// Bracket and schedule management
router.post(
  '/:tournamentId/generate-brackets',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('format')
      .optional()
      .isIn([
        'single-elimination',
        'double-elimination',
        'round-robin',
        'group-stage',
      ])
      .withMessage('Invalid tournament format'),
  ],
  tournamentController.generateBrackets
);

router.post(
  '/:tournamentId/generate-schedule',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('startDate').isISO8601().withMessage('Valid start date is required'),
    body('endDate').isISO8601().withMessage('Valid end date is required'),
    body('startTime')
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid start time is required'),
    body('endTime')
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid end time is required'),
    body('courts').isArray().withMessage('Courts must be an array'),
  ],
  tournamentController.generateSchedule
);

// Manual bracket management routes
router.post(
  '/:tournamentId/bracket/round/:round',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
    body('matches').isArray().withMessage('Matches must be an array'),
  ],
  tournamentController.createManualBracket
);

router.get(
  '/:tournamentId/bracket/round/:round',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
  ],
  tournamentController.getBracketMatches
);

router.delete(
  '/:tournamentId/bracket/round/:round',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
  ],
  tournamentController.clearRoundMatches
);

// Match management
router.put(
  '/match/:matchId',
  requireAuth,
  requireAdmin,
  [param('matchId').isMongoId().withMessage('Invalid match ID')],
  validateMatchUpdate,
  tournamentController.updateMatch
);

// Update match team assignment (for drag-drop)
router.patch(
  '/match/:matchId/teams',
  requireAuth,
  requireAdmin,
  [
    param('matchId').isMongoId().withMessage('Invalid match ID'),
    body('team1').optional().isMongoId().withMessage('Valid team ID required'),
    body('team2').optional().isMongoId().withMessage('Valid team ID required'),
    body('position')
      .optional()
      .isIn(['team1', 'team2'])
      .withMessage('Position must be team1 or team2'),
  ],
  tournamentController.updateMatchTeams
);

// Tournament lifecycle
router.put(
  '/:tournamentId/start',
  requireAuth,
  requireAdmin,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.startTournament
);

router.put(
  '/:tournamentId/complete',
  requireAuth,
  requireAdmin,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.completeTournament
);

// ============================================
// NEW BRACKET PROGRESSION ROUTES
// ============================================

// Get tournament bracket progress
router.get(
  '/:tournamentId/progress',
  requireAuth,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.getTournamentProgress ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Get round summary
router.get(
  '/:tournamentId/round/:round/summary',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
  ],
  tournamentController.getRoundSummary ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Get winning teams for a round
router.get(
  '/:tournamentId/round/:round/winners',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
  ],
  tournamentController.getWinningTeams ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Advance to next round
router.post(
  '/:tournamentId/advance-round',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
    body('autoAssignTeams')
      .optional()
      .isBoolean()
      .withMessage('autoAssignTeams must be boolean'),
  ],
  tournamentController.advanceToNextRound ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Complete a round
router.post(
  '/:tournamentId/round/:round/complete',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('round')
      .isInt({ min: 1 })
      .withMessage('Round must be a positive integer'),
    body('force').optional().isBoolean().withMessage('force must be boolean'),
  ],
  tournamentController.completeRound ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Reset a match
router.post(
  '/match/:matchId/reset',
  requireAuth,
  requireAdmin,
  [param('matchId').isMongoId().withMessage('Invalid match ID')],
  tournamentController.resetMatch ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Quick declare winner
router.post(
  '/match/:matchId/quick-declare-winner',
  requireAuth,
  requireAdmin,
  [
    param('matchId').isMongoId().withMessage('Invalid match ID'),
    body('winnerId').isMongoId().withMessage('Valid winner ID required'),
    body('team1Score')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Team 1 score must be positive integer'),
    body('team2Score')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Team 2 score must be positive integer'),
    body('isWalkover')
      .optional()
      .isBoolean()
      .withMessage('isWalkover must be boolean'),
  ],
  tournamentController.quickDeclareWinner ||
    (async (req, res) => {
      res.status(501).json({ success: false, message: 'Not implemented yet' });
    })
);

// Data retrieval
router.get(
  '/:tournamentId/standings',
  requireAuth,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.getStandings
);

router.get(
  '/:tournamentId/schedule',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    query('date').optional().isISO8601().withMessage('Valid date required'),
    query('court').optional().isString().withMessage('Court must be string'),
    query('status')
      .optional()
      .isIn(['scheduled', 'in-progress', 'completed', 'cancelled'])
      .withMessage('Invalid status'),
  ],
  tournamentController.getSchedule
);

// Schedule management routes
router.post(
  '/:tournamentId/schedule/generate',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('startDate').isISO8601().withMessage('Valid start date is required'),
    body('endDate').isISO8601().withMessage('Valid end date is required'),
    body('startTime')
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid start time is required'),
    body('endTime')
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid end time is required'),
    body('courts').isArray().withMessage('Courts must be an array'),
    body('matchDuration')
      .optional()
      .isInt({ min: 10, max: 120 })
      .withMessage('Match duration must be between 10 and 120 minutes'),
    body('breakDuration')
      .optional()
      .isInt({ min: 0, max: 60 })
      .withMessage('Break duration must be between 0 and 60 minutes'),
  ],
  tournamentController.generateTournamentSchedule
);

router.post(
  '/:tournamentId/schedule/bulk',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('scheduleData')
      .isArray()
      .withMessage('Schedule data must be an array'),
  ],
  tournamentController.bulkScheduleMatches
);

router.get(
  '/:tournamentId/schedule/date/:date',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('date').isISO8601().withMessage('Valid date is required'),
  ],
  tournamentController.getScheduleForDate
);

router.get(
  '/:tournamentId/schedule/available-slots',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    query('date').optional().isISO8601().withMessage('Valid date required'),
    query('startTime')
      .optional()
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid start time required'),
    query('endTime')
      .optional()
      .matches(/^([01]?[0-9]|2[0-3]):[0-5][0-9]$/)
      .withMessage('Valid end time required'),
    query('court').optional().isString().withMessage('Court must be string'),
  ],
  tournamentController.getAvailableTimeSlots
);

router.put(
  '/schedule/match/:matchId',
  requireAuth,
  requireAdmin,
  [
    param('matchId').isMongoId().withMessage('Invalid match ID'),
    body('scheduledTime')
      .optional()
      .isISO8601()
      .withMessage('Valid scheduled time required'),
    body('court').optional().isString().withMessage('Court must be string'),
    body('duration')
      .optional()
      .isInt({ min: 10, max: 120 })
      .withMessage('Duration must be between 10 and 120 minutes'),
    body('referee')
      .optional()
      .isMongoId()
      .withMessage('Valid referee ID required'),
  ],
  tournamentController.updateMatchSchedule
);

router.get(
  '/:tournamentId/matches/unscheduled',
  requireAuth,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.getUnscheduledMatches
);

// Schedule reset routes
router.get(
  '/:tournamentId/schedule/can-reset',
  requireAuth,
  requireAdmin,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  tournamentController.canResetSchedule
);

router.post(
  '/:tournamentId/schedule/reset',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('resetType')
      .optional()
      .isIn(['soft', 'hard', 'partial'])
      .withMessage('Reset type must be soft, hard, or partial'),
  ],
  tournamentController.resetTournamentSchedule
);

router.post(
  '/:tournamentId/bracket/recreate',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('format')
      .optional()
      .isIn([
        'single-elimination',
        'double-elimination',
        'round-robin',
        'group-stage',
      ])
      .withMessage('Invalid tournament format'),
    body('seeding')
      .optional()
      .isIn(['random', 'ranked', 'manual'])
      .withMessage('Invalid seeding type'),
  ],
  tournamentController.recreateBracket
);

// Bulk schedule matches
router.post(
  '/:tournamentId/schedule/bulk',
  requireAuth,
  requireAdmin,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    body('matches').isArray().withMessage('Matches must be an array'),
  ],
  async (req, res) => {
    try {
      const { tournamentId } = req.params;
      const { matches } = req.body;

      console.log(
        `📅 Bulk scheduling ${matches.length} matches for tournament ${tournamentId}`
      );

      const results = [];

      for (const matchData of matches) {
        let match;

        // Check if match already exists
        if (matchData._id && !matchData._id.startsWith('temp-')) {
          match = await Match.findById(matchData._id);
        }

        if (match) {
          // Update existing match
          match.scheduledTime = matchData.scheduledTime;
          match.timeSlot = matchData.timeSlot;
          match.court = matchData.court;
          match.group = matchData.group;
          match.pool = matchData.pool;
          match.sequence = matchData.sequence;
          match.status = 'scheduled';
        } else {
          // Create new match
          match = new Match({
            tournament: tournamentId,
            round: matchData.round || 1,
            matchNumber: matchData.matchNumber || 1,
            team1: matchData.team1,
            team2: matchData.team2,
            scheduledTime: matchData.scheduledTime,
            timeSlot: matchData.timeSlot,
            court: matchData.court,
            group: matchData.group,
            pool: matchData.pool,
            sequence: matchData.sequence,
            status: 'scheduled',
            bracketType: 'winners',
          });
        }

        await match.save();
        results.push(match);
      }

      res.json({
        success: true,
        message: `Successfully scheduled ${results.length} matches`,
        matches: results,
      });
    } catch (error) {
      console.error('Error bulk scheduling matches:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to bulk schedule matches',
        error: error.message,
      });
    }
  }
);

// Get schedule for a specific day
router.get(
  '/:tournamentId/schedule/day/:date',
  requireAuth,
  [
    param('tournamentId').isMongoId().withMessage('Invalid tournament ID'),
    param('date').isISO8601().withMessage('Valid date required'),
  ],
  async (req, res) => {
    try {
      const { tournamentId, date } = req.params;

      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);

      const matches = await Match.find({
        tournament: tournamentId,
        scheduledTime: {
          $gte: startDate,
          $lte: endDate,
        },
      })
        .populate('team1', 'name grade sex levelOfCompetition')
        .populate('team2', 'name grade sex levelOfCompetition')
        .populate('winner', 'name')
        .populate('loser', 'name')
        .sort('scheduledTime court');

      // Group by time slot for easier consumption
      const scheduleByTimeSlot = {};
      matches.forEach((match) => {
        const timeSlot = match.timeSlot || 'Unscheduled';
        if (!scheduleByTimeSlot[timeSlot]) {
          scheduleByTimeSlot[timeSlot] = [];
        }
        scheduleByTimeSlot[timeSlot].push(match);
      });

      res.json({
        success: true,
        date: date,
        totalMatches: matches.length,
        schedule: scheduleByTimeSlot,
        matches: matches,
      });
    } catch (error) {
      console.error('Error getting schedule for day:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get schedule for day',
        error: error.message,
      });
    }
  }
);

// Get team schedules
router.get(
  '/:tournamentId/schedule/teams',
  requireAuth,
  [param('tournamentId').isMongoId().withMessage('Invalid tournament ID')],
  async (req, res) => {
    try {
      const { tournamentId } = req.params;

      const matches = await Match.find({
        tournament: tournamentId,
        status: { $in: ['scheduled', 'in-progress', 'completed'] },
      })
        .populate('team1', 'name grade sex levelOfCompetition')
        .populate('team2', 'name grade sex levelOfCompetition')
        .sort('scheduledTime');

      // Create team schedule map
      const teamSchedules = {};

      matches.forEach((match) => {
        if (match.team1) {
          const teamId = match.team1._id.toString();
          if (!teamSchedules[teamId]) {
            teamSchedules[teamId] = {
              team: match.team1,
              matches: [],
            };
          }
          teamSchedules[teamId].matches.push({
            matchId: match._id,
            timeSlot: match.timeSlot,
            court: match.court,
            scheduledTime: match.scheduledTime,
            opponent: match.team2?.name || 'TBD',
            status: match.status,
          });
        }

        if (match.team2) {
          const teamId = match.team2._id.toString();
          if (!teamSchedules[teamId]) {
            teamSchedules[teamId] = {
              team: match.team2,
              matches: [],
            };
          }
          teamSchedules[teamId].matches.push({
            matchId: match._id,
            timeSlot: match.timeSlot,
            court: match.court,
            scheduledTime: match.scheduledTime,
            opponent: match.team1?.name || 'TBD',
            status: match.status,
          });
        }
      });

      res.json({
        success: true,
        teamSchedules: Object.values(teamSchedules),
      });
    } catch (error) {
      console.error('Error getting team schedules:', error);
      res.status(500).json({
        success: false,
        message: 'Failed to get team schedules',
        error: error.message,
      });
    }
  }
);

module.exports = router;
