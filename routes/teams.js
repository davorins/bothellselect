// routes/teams.js
const router = require('express').Router();
const Team = require('../models/Team');
const Player = require('../models/Player'); // ← Uncomment when Player model exists
const { authenticate } = require('../utils/auth');

// ─────────────────────────────────────────────────────────────────────────────
// METADATA ENDPOINT — Returns years, grades, tryout seasons
// ─────────────────────────────────────────────────────────────────────────────
router.get('/internal-teams/metadata', authenticate, async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();

    // Rolling range: 2 years back → 2 years forward
    const years = [];
    for (let i = -2; i <= 2; i++) {
      years.push(currentYear + i);
    }

    const tryoutSeasons = [
      'Basketball Select Tryout',
      'Spring Tryout',
      'Fall Tryout',
    ];

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

    res.json({ years, grades, tryoutSeasons });
  } catch (error) {
    console.error('Error fetching metadata:', error);
    res.status(500).json({ error: 'Failed to fetch metadata' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AVAILABLE PLAYERS — Returns players who completed the given tryout
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  '/internal-teams/available-players',
  authenticate,
  async (req, res) => {
    try {
      const { season, year, gender } = req.query;

      if (!season || !year) {
        return res.json([]); // No filters → no players
      }

      // If Player model exists, query it. Otherwise return empty array.
      // Uncomment when Player model is ready:
      /*
      const filter = {
        isActive: true,
        'tryouts.season': season,
        'tryouts.year': parseInt(year),
        'tryouts.completed': true,
      };
      if (gender) filter.gender = gender;

      const players = await Player.find(filter)
        .select('fullName gender grade schoolName dob')
        .sort({ grade: 1, fullName: 1 })
        .lean();

      return res.json(players);
      */

      // Placeholder until Player model is wired up:
      res.json([]);
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
      filter.$or = [{ tournament }, { 'tournaments.tournament': tournament }];
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

    if (!team)
      return res.status(404).json({ success: false, error: 'Team not found' });
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
// CREATE NEW TEAM
// ─────────────────────────────────────────────────────────────────────────────
router.post('/teams', authenticate, async (req, res) => {
  try {
    const {
      name,
      year,
      grade,
      gender,
      sex,
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

    const teamSex = sex || gender;
    if (!name || !grade || !teamSex) {
      return res.status(400).json({
        success: false,
        error: 'Name, grade, and gender/sex are required fields',
      });
    }

    // Coerce year fields to numbers
    const teamYear =
      Number(year) || Number(registrationYear) || new Date().getFullYear();
    const tryoutYearNum = Number(tryoutYear) || teamYear;

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

    let tournamentData = tournaments;
    if (tournamentData.length === 0 && tournament) {
      tournamentData = [
        {
          tournament,
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
      tryoutYear: tryoutYearNum,
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
    if (!team)
      return res.status(404).json({ success: false, error: 'Team not found' });

    const updates = { ...req.body };
    if (updates.gender && !updates.sex) {
      updates.sex = updates.gender;
      delete updates.gender;
    }
    // Coerce numeric fields
    if (updates.year) updates.year = Number(updates.year);
    if (updates.tryoutYear) updates.tryoutYear = Number(updates.tryoutYear);
    if (updates.registrationYear)
      updates.registrationYear = Number(updates.registrationYear);

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
    if (!team)
      return res.status(404).json({ success: false, error: 'Team not found' });

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
