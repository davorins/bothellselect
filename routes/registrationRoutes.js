// backend/routes/registrationRoutes.js
const express = require('express');
const {
  getSeasonEvents,
  createSeasonEvent,
  updateSeasonEvent,
  deleteSeasonEvent,
  getFormConfigs,
  getFormConfig,
  updateFormConfig,
  getActiveForms,
} = require('../controllers/registrationController');
const {
  getTournamentConfigs,
  updateTournamentConfig,
  getTournamentConfig,
  deleteTournamentConfig,
  TournamentConfig,
} = require('../controllers/tournamentConfigController');
const {
  getTryoutConfigs,
  updateTryoutConfig,
  getTryoutConfig,
  deleteTryoutConfig,
} = require('../controllers/tryoutConfigController');
const { authenticate, isAdmin } = require('../utils/auth');

const router = express.Router();

// Season Events (for training only)
router.get('/season-events', getSeasonEvents);
router.post('/season-events', authenticate, isAdmin, createSeasonEvent);
router.put('/season-events/:eventId', authenticate, isAdmin, updateSeasonEvent);
router.delete(
  '/season-events/:eventId',
  authenticate,
  isAdmin,
  deleteSeasonEvent
);

// Form Configurations (for training only)
router.get('/form-configs', getFormConfigs);
router.get('/form-config', getFormConfig);
router.put('/form-configs', authenticate, isAdmin, updateFormConfig);

// Tournament Configurations (completely separate)
router.get('/tournament-configs', getTournamentConfigs);
router.put(
  '/tournament-configs',
  authenticate,
  isAdmin,
  updateTournamentConfig
);
router.get('/tournament-configs/:tournamentName', getTournamentConfig);
router.delete(
  '/tournament-configs/:tournamentName',
  authenticate,
  isAdmin,
  deleteTournamentConfig
);

// Tryout Configurations
router.get('/tryout-configs', getTryoutConfigs);
router.put('/tryout-configs', authenticate, isAdmin, updateTryoutConfig);
router.get('/tryout-configs/:tryoutName', getTryoutConfig);
router.delete(
  '/tryout-configs/:tryoutName',
  authenticate,
  isAdmin,
  deleteTryoutConfig
);

// Active Forms (for training only)
router.get('/active-forms', getActiveForms);

router.post('/tournaments/create', authenticate, async (req, res) => {
  try {
    const {
      tournamentName,
      tournamentYear,
      displayName,
      tournamentFee = 425,
      registrationDeadline,
      tournamentDates,
      locations,
      divisions = ['Gold', 'Silver'],
      ageGroups = [],
      requiresRoster = true,
      requiresInsurance = true,
      paymentDeadline,
      refundPolicy = 'No refunds after registration deadline',
      rulesDocumentUrl,
      scheduleDocumentUrl,
      isActive = true,
    } = req.body;

    // Check if tournament already exists
    const existingTournament = await TournamentConfig.findOne({
      tournamentName,
      tournamentYear,
    });

    if (existingTournament) {
      return res.status(400).json({
        success: false,
        error: 'Tournament already exists for this year',
      });
    }

    // Create new tournament
    const tournament = new TournamentConfig({
      tournamentName,
      tournamentYear,
      displayName,
      tournamentFee,
      registrationDeadline: registrationDeadline
        ? new Date(registrationDeadline)
        : null,
      tournamentDates: tournamentDates
        ? tournamentDates.map((d) => new Date(d))
        : [],
      locations,
      divisions,
      ageGroups,
      requiresRoster,
      requiresInsurance,
      paymentDeadline: paymentDeadline ? new Date(paymentDeadline) : null,
      refundPolicy,
      rulesDocumentUrl,
      scheduleDocumentUrl,
      isActive,
    });

    await tournament.save();

    res.status(201).json({
      success: true,
      message: 'Tournament created successfully',
      tournament,
    });
  } catch (error) {
    console.error('Error creating tournament:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create tournament',
      details: error.message,
    });
  }
});

module.exports = router;
