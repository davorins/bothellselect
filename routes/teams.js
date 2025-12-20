const router = require('express').Router();
const Team = require('../models/Team');
const { authenticate } = require('../utils/auth');

// Get teams with pagination and filtering
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
      isActive = 'true', // Changed default to string for consistency
      page = 1,
      limit = 100,
      sortBy = 'name',
      sortOrder = 'asc',
    } = req.query;

    // Build filter object
    const filter = {};

    // Handle isActive - convert string to boolean if provided
    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    if (name) {
      filter.name = { $regex: name, $options: 'i' };
    }
    if (grade) {
      filter.grade = grade;
    }
    if (sex) {
      filter.sex = sex;
    }
    if (levelOfCompetition) {
      filter.levelOfCompetition = levelOfCompetition;
    }
    if (tournament) {
      // Search in both tournament field and tournaments array
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
          { 'tournaments.year': yearNum },
        ];
      }
    }
    if (coachId) {
      filter.coachIds = coachId; // Use direct equality for single coach search
    }

    // Validate pagination parameters
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(1000, Math.max(1, parseInt(limit) || 100));
    const skip = (pageNum - 1) * limitNum;

    // Validate sort parameters
    const allowedSortFields = [
      'name',
      'grade',
      'sex',
      'levelOfCompetition',
      'registrationYear',
      'createdAt',
    ];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'name';
    const sortDirection = sortOrder === 'desc' ? -1 : 1;

    const sort = { [sortField]: sortDirection };

    // Execute query with pagination
    const [teams, total] = await Promise.all([
      Team.find(filter)
        .populate('coachIds', 'fullName email phone')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean(),
      Team.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: teams, // Changed from 'teams' to 'data' for consistency
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

// Get all teams without pagination (for dropdowns)
router.get('/teams/all', authenticate, async (req, res) => {
  try {
    const { isActive = 'true' } = req.query;
    const filter = {};

    if (isActive !== undefined) {
      filter.isActive = isActive === 'true';
    }

    const teams = await Team.find(filter)
      .populate('coachIds', 'fullName email')
      .sort({ name: 1 })
      .lean();

    res.json({
      success: true,
      data: teams,
    });
  } catch (error) {
    console.error('Error fetching all teams:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch teams',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get team by ID
router.get('/teams/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid team ID format',
      });
    }

    const team = await Team.findById(id)
      .populate('coachIds', 'fullName email phone')
      .populate('tournaments.tournament', 'name year') // If tournaments reference a Tournament model
      .lean();

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found',
      });
    }

    res.json({
      success: true,
      data: team,
    });
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

// Create new team
router.post('/teams', authenticate, async (req, res) => {
  try {
    const {
      name,
      grade,
      sex,
      levelOfCompetition,
      tournament,
      registrationYear = new Date().getFullYear(),
      coachIds = [],
      tournaments = [],
      isActive = true,
    } = req.body;

    // Validate required fields
    if (!name || !grade || !sex) {
      return res.status(400).json({
        success: false,
        error: 'Name, grade, and sex are required fields',
      });
    }

    // Check if team already exists (case-insensitive)
    const existingTeam = await Team.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
      grade,
      sex,
      isActive: true,
    });

    if (existingTeam) {
      return res.status(409).json({
        // 409 Conflict
        success: false,
        error: 'Team with this name, grade, and gender already exists',
        existingTeamId: existingTeam._id,
      });
    }

    // Prepare tournament data
    const tournamentData =
      tournaments.length > 0
        ? tournaments
        : [
            {
              tournament: tournament || '',
              year: registrationYear,
              levelOfCompetition: levelOfCompetition || '',
              paymentStatus: 'pending',
              paymentComplete: false,
              registeredAt: new Date(),
            },
          ];

    const team = new Team({
      name: name.trim(),
      grade,
      sex,
      levelOfCompetition: levelOfCompetition || '',
      tournament: tournament || '',
      registrationYear,
      coachIds,
      tournaments: tournamentData,
      isActive,
      createdBy: req.user?.id, // Assuming user info is available
      createdAt: new Date(),
    });

    await team.save();

    // Populate the created team
    const populatedTeam = await Team.findById(team._id)
      .populate('coachIds', 'fullName email phone')
      .lean();

    res.status(201).json({
      success: true,
      message: 'Team created successfully',
      data: populatedTeam,
    });
  } catch (error) {
    console.error('Error creating team:', error);

    // Handle validation errors
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

// Update team
router.put('/teams/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid team ID format',
      });
    }

    const team = await Team.findById(id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found',
      });
    }

    // Check for duplicate team name if name is being updated
    if (req.body.name && req.body.name !== team.name) {
      const existingTeam = await Team.findOne({
        name: { $regex: new RegExp(`^${req.body.name.trim()}$`, 'i') },
        grade: req.body.grade || team.grade,
        sex: req.body.sex || team.sex,
        _id: { $ne: id }, // Exclude current team
      });

      if (existingTeam) {
        return res.status(409).json({
          success: false,
          error: 'Team with this name, grade, and gender already exists',
        });
      }
    }

    // Update team fields
    Object.keys(req.body).forEach((key) => {
      if (key !== '_id' && key !== '__v') {
        team[key] = req.body[key];
      }
    });

    team.updatedAt = new Date();
    team.updatedBy = req.user?.id;

    await team.save();

    // Populate the updated team
    const populatedTeam = await Team.findById(team._id)
      .populate('coachIds', 'fullName email phone')
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

// Delete team (soft delete)
router.delete('/teams/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    // Validate ID format
    if (!id.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid team ID format',
      });
    }

    const team = await Team.findById(id);

    if (!team) {
      return res.status(404).json({
        success: false,
        error: 'Team not found',
      });
    }

    // Check if team can be deleted (e.g., has active tournaments)
    const hasActiveTournaments = team.tournaments?.some(
      (t) => t.paymentComplete === false || t.paymentStatus === 'pending'
    );

    if (hasActiveTournaments && req.query.force !== 'true') {
      return res.status(400).json({
        success: false,
        error: 'Team has active tournaments. Use force=true to delete anyway.',
        hasActiveTournaments: true,
      });
    }

    team.isActive = false;
    team.deactivatedAt = new Date();
    team.deactivatedBy = req.user?.id;
    await team.save();

    res.json({
      success: true,
      message: 'Team deleted successfully',
    });
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

// Search teams
router.get('/teams/search/:query', authenticate, async (req, res) => {
  try {
    const { query } = req.params;
    const { limit = 20 } = req.query;

    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Search query must be at least 2 characters long',
      });
    }

    const teams = await Team.find({
      $or: [
        { name: { $regex: query, $options: 'i' } },
        { grade: { $regex: query, $options: 'i' } },
        { tournament: { $regex: query, $options: 'i' } },
        { 'tournaments.tournament': { $regex: query, $options: 'i' } },
      ],
      isActive: true,
    })
      .populate('coachIds', 'fullName email')
      .limit(Math.min(50, parseInt(limit) || 20))
      .lean();

    res.json({
      success: true,
      data: teams,
      count: teams.length,
    });
  } catch (error) {
    console.error('Error searching teams:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to search teams',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Get teams by tournament
router.get(
  '/teams/tournament/:tournament/:year',
  authenticate,
  async (req, res) => {
    try {
      const { tournament, year } = req.params;
      const yearNum = parseInt(year);

      if (!tournament || isNaN(yearNum)) {
        return res.status(400).json({
          success: false,
          error: 'Valid tournament name and year are required',
        });
      }

      const teams = await Team.find({
        'tournaments.tournament': tournament,
        'tournaments.year': yearNum,
        isActive: true,
      })
        .populate('coachIds', 'fullName email phone')
        .populate('tournaments.tournament', 'name location') // If tournament is a reference
        .sort({ name: 1 })
        .lean();

      res.json({
        success: true,
        data: teams,
        count: teams.length,
        tournament,
        year: yearNum,
      });
    } catch (error) {
      console.error('Error fetching tournament teams:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to fetch tournament teams',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

// Get teams by coach
router.get('/teams/coach/:coachId', authenticate, async (req, res) => {
  try {
    const { coachId } = req.params;

    // Validate ID format
    if (!coachId.match(/^[0-9a-fA-F]{24}$/)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid coach ID format',
      });
    }

    const teams = await Team.find({
      coachIds: coachId,
      isActive: true,
    })
      .populate('coachIds', 'fullName email')
      .sort({ name: 1 })
      .lean();

    res.json({
      success: false,
      data: teams,
      count: teams.length,
    });
  } catch (error) {
    console.error('Error fetching coach teams:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch coach teams',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
