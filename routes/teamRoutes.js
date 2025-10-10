const express = require('express');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const InternalTeam = require('../models/InternalTeam');
const Player = require('../models/Player');
const Parent = require('../models/Parent');
const { authenticate } = require('../utils/auth');

const router = express.Router();

// Get all internal teams
router.get('/internal-teams', authenticate, async (req, res) => {
  try {
    const { season, year, grade, gender, status } = req.query;

    let query = {};
    if (season) query.season = season;
    if (year) query.year = parseInt(year);
    if (grade) query.grade = grade;
    if (gender) query.gender = gender;
    if (status) query.status = status;

    const teams = await InternalTeam.find(query)
      .populate('coachIds', 'fullName email phone')
      .populate('playerIds', 'fullName gender dob schoolName grade avatar')
      .sort({ createdAt: -1 });

    res.json(teams);
  } catch (error) {
    console.error('Error fetching internal teams:', error);
    res.status(500).json({ error: 'Failed to fetch teams' });
  }
});

// Get players available for team creation (players who made tryouts)
router.get(
  '/internal-teams/available-players',
  authenticate,
  async (req, res) => {
    try {
      const { season, year, grade, gender } = req.query;

      let query = {
        'seasons.season': season || 'Basketball Select Tryout',
        'seasons.paymentComplete': true,
        'seasons.paymentStatus': 'paid',
      };

      if (year) {
        query['seasons.year'] = parseInt(year);
      }
      if (grade) {
        query.grade = grade;
      }
      if (gender && gender !== 'Coed') {
        query.gender = gender;
      }

      console.log('Available players query:', query);

      const availablePlayers = await Player.find(query)
        .populate('parentId', 'fullName email phone')
        .sort({ 'seasons.registrationDate': -1 });

      console.log(`Found ${availablePlayers.length} available players`);

      // Transform players to include parent emails
      const playersWithParents = availablePlayers.map((player) => {
        const playerObj = player.toObject();
        let parents = [];

        // Get parent emails from populated parentId
        if (playerObj.parentId && playerObj.parentId.email) {
          parents.push({ email: playerObj.parentId.email });
        }

        // Get additional parents from parents array if available
        if (playerObj.parents && Array.isArray(playerObj.parents)) {
          parents = [...parents, ...playerObj.parents.filter((p) => p.email)];
        }

        return {
          ...playerObj,
          parents: parents,
        };
      });

      res.json(playersWithParents);
    } catch (error) {
      console.error('Error fetching available players:', error);
      res.status(500).json({ error: 'Failed to fetch available players' });
    }
  }
);

// ✅ FIX: Move metadata route ABOVE the :id route
// Get available seasons and metadata
router.get('/internal-teams/metadata', authenticate, async (req, res) => {
  try {
    // REMOVED seasons from metadata
    const years = await InternalTeam.distinct('year');
    const grades = await InternalTeam.distinct('grade');
    const tryoutSeasons = await Player.distinct('seasons.season', {
      'seasons.paymentComplete': true,
      'seasons.paymentStatus': 'paid',
    });

    res.json({
      years: years.sort((a, b) => b - a),
      grades: grades.sort(),
      tryoutSeasons: tryoutSeasons
        .filter((s) => s && s.includes('Tryout'))
        .sort(),
    });
  } catch (error) {
    console.error('Error fetching internal team metadata:', error);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// Get internal team by ID - this should come AFTER specific routes
router.get('/internal-teams/:id', authenticate, async (req, res) => {
  try {
    const team = await InternalTeam.findById(req.params.id)
      .populate('coachIds', 'fullName email phone avatar')
      .populate(
        'playerIds',
        'fullName gender dob age schoolName grade avatar seasons parents'
      );

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json(team);
  } catch (error) {
    console.error('Error fetching internal team:', error);
    res.status(500).json({ error: 'Failed to fetch team' });
  }
});

// Create new internal team from tryout players
router.post(
  '/internal-teams',
  authenticate,
  [
    body('name').notEmpty().withMessage('Team name is required'),
    body('year')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Valid year is required'),
    body('grade').notEmpty().withMessage('Grade is required'),
    body('gender')
      .isIn(['Male', 'Female', 'Coed'])
      .withMessage('Valid gender is required'),
    body('tryoutSeason').notEmpty().withMessage('Tryout season is required'),
    body('tryoutYear')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Valid tryout year is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const {
        name,
        year,
        grade,
        gender,
        coachIds,
        playerIds,
        tryoutSeason,
        tryoutYear,
        notes,
      } = req.body;

      // Check if team name already exists for this year
      const existingTeam = await InternalTeam.findOne({
        name,
        year,
      });
      if (existingTeam) {
        return res
          .status(400)
          .json({ error: 'Team name already exists for this year' });
      }

      const team = new InternalTeam({
        name,
        year,
        grade,
        gender,
        coachIds: coachIds || [],
        playerIds: playerIds || [],
        tryoutSeason,
        tryoutYear,
        notes: notes || '',
      });

      await team.save();

      // Populate the response
      const populatedTeam = await InternalTeam.findById(team._id)
        .populate('coachIds', 'fullName email phone')
        .populate('playerIds', 'fullName gender dob schoolName grade');

      res.status(201).json(populatedTeam);
    } catch (error) {
      console.error('Error creating internal team:', error);
      res.status(500).json({ error: 'Failed to create team' });
    }
  }
);

// Update internal team
router.put('/internal-teams/:id', authenticate, async (req, res) => {
  try {
    const { name, grade, gender, coachIds, playerIds, status, notes } =
      req.body;

    const team = await InternalTeam.findByIdAndUpdate(
      req.params.id,
      {
        name,
        grade,
        gender,
        coachIds,
        playerIds,
        status,
        notes,
        updatedAt: new Date(),
      },
      { new: true, runValidators: true }
    )
      .populate('coachIds', 'fullName email phone')
      .populate('playerIds', 'fullName gender dob schoolName grade');

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json(team);
  } catch (error) {
    console.error('Error updating internal team:', error);
    res.status(500).json({ error: 'Failed to update team' });
  }
});

// Delete internal team (soft delete)
router.delete('/internal-teams/:id', authenticate, async (req, res) => {
  try {
    const team = await InternalTeam.findByIdAndUpdate(
      req.params.id,
      { status: 'inactive' },
      { new: true }
    );

    if (!team) {
      return res.status(404).json({ error: 'Team not found' });
    }

    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    console.error('Error deleting internal team:', error);
    res.status(500).json({ error: 'Failed to delete team' });
  }
});

module.exports = router;
