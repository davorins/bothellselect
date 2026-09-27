// routes/teams.js
const router = require('express').Router();
const Team = require('../models/Team');
const { authenticate } = require('../utils/auth');

// ─────────────────────────────────────────────────────────────────────────────
// METADATA ENDPOINT (This fixes the "only 2025" issue)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/internal-teams/metadata', authenticate, async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();

    // Generate a rolling range of years (e.g., 2 years back to 2 years forward)
    const years = [];
    for (let i = -2; i <= 2; i++) {
      years.push(currentYear + i);
    }

    // Define available tryout seasons. Adjust as needed.
    const tryoutSeasons = [
      'Basketball Select Tryout',
      'Spring Tryout',
      'Fall Tryout',
    ];

    // Define available grades
    const grades = [
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
      '11',
      '12',
    ];

    res.json({
      years,
      grades,
      tryoutSeasons,
    });
  } catch (error) {
    console.error('Error fetching metadata:', error);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABLE PLAYERS ENDPOINT (Used by the form to filter players)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/internal-teams/available-players',
  authenticate,
  async (req, res) => {
    try {
      const { season, year, gender } = req.query;

      // TODO: Replace this with actual logic to find players who completed tryouts.
      // For now, we return an empty array to prevent the frontend from crashing.
      // If you have a Player model with tryout data, query it here.

      // Example (pseudo-code):
      // const filter = { tryoutSeason: season, tryoutYear: year };
      // if (gender) filter.gender = gender;
      // const players = await Player.find(filter).lean();

      const players = []; // Replace with actual query

      res.json(players);
    } catch (error) {
      console.error('Error fetching available players:', error);
      res.status(500).json({ error: 'Failed to fetch available players' });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET ALL TEAMS (Paginated)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/teams', authenticate, async (req, res) => {
  try {
    const {
      name,
      grade,
      sex,
      levelOfCompetition,
      tournament,
      year,
      coachId,
      isActive = 'true',
      page = 1,
      limit = 100,
      sortBy = 'name',
      sortOrder = 'asc',
    } = req.query;

    const filter = {};

    if (isActive !== undefined) filter.isActive = isActive === 'true';
    if (name) filter.name = { $regex: name, $options: 'i' };
    if (grade) filter.grade = grade;
    if (sex) filter.sex = sex;
    if (levelOfCompetition) filter.levelOfCompetition = levelOfCompetition;
    if (tournament) {
      filter.$or = [
        { tournament: tournament },
        { 'tournaments.tournament': tournament },
      ];
    }
    if (year) {
      const yearNum = parseInt(year);
      if (!isNaN(yearNum)) {
        filter.$or = [
          { registrationYear: yearNum },
          { year: yearNum },
          { 'tournaments.year': yearNum },
        ];
      }
    }
    if (coachId) filter.coachIds = coachId;

    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(1000, Math.max(1, parseInt(limit) || 100));
    const skip = (pageNum - 1) * limitNum;

    const allowedSortFields = [
      'name',
      'grade',
      'sex',
      'levelOfCompetition',
      'registrationYear',
      'year',
      'createdAt',
    ];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'name';
    const sortDirection = sortOrder === 'desc' ? -1 : 1;

    const [teams, total] = await Promise.all([
      Team.find(filter)
        .populate('coachIds', 'fullName email phone')
        .populate('playerIds', 'fullName grade schoolName')
        .sort({ [sortField]: sortDirection })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Team.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: teams,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
        hasNext: pageNum * limitNum < total,
        hasPrev: pageNum > 1,
      },
    });
  } catch (error) {
    console.error('Error fetching teams:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch teams',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET TEAM BY ID
// ─────────────────────────────────────────────────────────────────────────────
router.get('/teams/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid team ID format' });
    }

    const team = await Team.findById(id)
      .populate('coachIds', 'fullName email phone')
      .populate('playerIds', 'fullName grade schoolName gender dob')
      .lean();

    if (!team) {
      return res.status(404).json({ success: false, error: 'Team not found' });
    }

    res.json({ success: true, data: team });
  } catch (error) {
    console.error('Error fetching team:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch team',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CREATE NEW TEAM (Handles both standard and tryout-based creation)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/teams', authenticate, async (req, res) => {
  try {
    const {
      name,
      year,
      grade,
      gender, // Frontend sends 'gender'
      sex, // Backend schema expects 'sex'
      tryoutSeason,
      tryoutYear,
      playerIds = [],
      coachIds = [],
      notes,
      levelOfCompetition,
      tournament,
      registrationYear,
      tournaments = [],
      isActive = true,
    } = req.body;

    // Normalize gender/sex
    const teamSex = sex || gender;

    // Validate required fields
    if (!name || !grade || !teamSex) {
      return res.status(400).json({
        success: false,
        error: 'Name, grade, and gender/sex are required fields',
      });
    }

    // Use 'year' for registrationYear if not explicitly provided
    const teamYear = year || registrationYear || new Date().getFullYear();

    // Check for duplicate
    const existingTeam = await Team.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      grade,
      sex: teamSex,
      year: teamYear,
      isActive: true,
    });

    if (existingTeam) {
      return res.status(409).json({
        success: false,
        error: 'Team with this name, grade, gender, and year already exists',
        existingTeamId: existingTeam._id,
      });
    }

    // Build tournament data only if provided (for non-tryout creation)
    let tournamentData = tournaments;
    if (tournamentData.length === 0 && tournament) {
      tournamentData = [
        {
          tournament: tournament,
          year: teamYear,
          levelOfCompetition: levelOfCompetition || '',
          paymentStatus: 'pending',
          paymentComplete: false,
          registrationDate: new Date(),
        },
      ];
    }

    const team = new Team({
      name: name.trim(),
      year: teamYear,
      grade,
      sex: teamSex,
      tryoutSeason: tryoutSeason || '',
      tryoutYear: tryoutYear || teamYear,
      playerIds,
      coachIds,
      notes: notes || '',
      levelOfCompetition: levelOfCompetition || null,
      tournament: tournament || '',
      registrationYear: teamYear,
      tournaments: tournamentData,
      isActive,
      createdBy: req.user?.id,
    });

    await team.save();

    const populatedTeam = await Team.findById(team._id)
      .populate('coachIds', 'fullName email phone')
      .populate('playerIds', 'fullName grade schoolName')
      .lean();

    res.status(201).json({
      success: true,
      message: 'Team created successfully',
      data: populatedTeam,
    });
  } catch (error) {
    console.error('Error creating team:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: Object.values(error.errors).map((err) => err.message),
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to create team',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE TEAM
// ─────────────────────────────────────────────────────────────────────────────
router.put('/teams/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid team ID format' });
    }

    const team = await Team.findById(id);
    if (!team) {
      return res.status(404).json({ success: false, error: 'Team not found' });
    }

    // Normalize gender -> sex if provided
    const updates = { ...req.body };
    if (updates.gender && !updates.sex) {
      updates.sex = updates.gender;
      delete updates.gender;
    }

    // Check for duplicate name if updating
    if (updates.name && updates.name !== team.name) {
      const existingTeam = await Team.findOne({
        name: { $regex: new RegExp(`^${updates.name.trim()}$`, 'i') },
        grade: updates.grade || team.grade,
        sex: updates.sex || team.sex,
        _id: { $ne: id },
      });
      if (existingTeam) {
        return res.status(409).json({
          success: false,
          error: 'Team with this name, grade, and gender already exists',
        });
      }
    }

    Object.keys(updates).forEach((key) => {
      if (key !== '_id' && key !== '__v') {
        team[key] = updates[key];
      }
    });

    team.updatedBy = req.user?.id;
    await team.save();

    const populatedTeam = await Team.findById(team._id)
      .populate('coachIds', 'fullName email phone')
      .populate('playerIds', 'fullName grade schoolName')
      .lean();

    res.json({
      success: true,
      message: 'Team updated successfully',
      data: populatedTeam,
    });
  } catch (error) {
    console.error('Error updating team:', error);
    if (error.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: 'Validation error',
        details: Object.values(error.errors).map((err) => err.message),
      });
    }
    res.status(500).json({
      success: false,
      error: 'Failed to update team',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE TEAM (Soft Delete)
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/teams/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid team ID format' });
    }

    const team = await Team.findById(id);
    if (!team) {
      return res.status(404).json({ success: false, error: 'Team not found' });
    }

    team.isActive = false;
    team.deactivatedAt = new Date();
    team.deactivatedBy = req.user?.id;
    await team.save();

    res.json({ success: true, message: 'Team deleted successfully' });
  } catch (error) {
    console.error('Error deleting team:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete team',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
