// routes/publicTournamentRoutes.js
const express = require('express');
const router = express.Router();
const Tournament = require('../models/Tournament');
const Match = require('../models/Match');
const Team = require('../models/Team');

// Public tournament listing
router.get('/tournaments/public', async (req, res) => {
  try {
    const {
      status,
      year,
      format,
      levelOfCompetition,
      sex,
      page = 1,
      limit = 20,
      search,
    } = req.query;

    const filter = { isActive: true };

    if (status) filter.status = status;
    if (year) filter.year = parseInt(year);
    if (format) filter.format = format;
    if (levelOfCompetition) filter.levelOfCompetition = levelOfCompetition;
    if (sex) filter.sex = sex;

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [tournaments, total] = await Promise.all([
      Tournament.find(filter)
        .populate('registeredTeams', 'name grade sex levelOfCompetition')
        .sort({ startDate: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Tournament.countDocuments(filter),
    ]);

    // Add virtual fields
    const tournamentsWithCounts = tournaments.map((tournament) => ({
      ...tournament,
      teamCount: tournament.registeredTeams?.length || 0,
      upcomingMatches: 0,
      liveMatches: 0,
      formattedStartDate: new Date(tournament.startDate).toLocaleDateString(),
      formattedEndDate: new Date(tournament.endDate).toLocaleDateString(),
    }));

    res.json({
      success: true,
      tournaments: tournamentsWithCounts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error('Error fetching public tournaments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournaments',
    });
  }
});

// Get specific tournament for public view
router.get('/tournaments/:id/public', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate(
        'registeredTeams',
        'name grade sex levelOfCompetition tournament'
      )
      .lean();

    if (!tournament || !tournament.isActive) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // Add virtual fields
    const tournamentWithStats = {
      ...tournament,
      teamCount: tournament.registeredTeams?.length || 0,
      formattedStartDate: new Date(tournament.startDate).toLocaleDateString(
        'en-US',
        {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }
      ),
      formattedEndDate: new Date(tournament.endDate).toLocaleDateString(
        'en-US',
        {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }
      ),
    };

    res.json(tournamentWithStats);
  } catch (error) {
    console.error('Error fetching tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament',
    });
  }
});

// Get matches for public view
// In your backend route for fetching matches
router.get('/tournaments/:id/matches/public', async (req, res) => {
  try {
    const matches = await Match.find({
      tournament: req.params.id,
      status: { $in: ['scheduled', 'in-progress', 'completed'] },
    })
      .populate('team1', 'name grade levelOfCompetition')
      .populate('team2', 'name grade levelOfCompetition')
      .populate('winner', 'name')
      .populate('loser', 'name')
      .sort({ round: 1, matchNumber: 1, scheduledTime: 1 })
      .lean();

    // DEBUG: Log what's being returned
    console.log('=== DEBUG: RETURNING MATCHES ===');
    matches.forEach((match, index) => {
      console.log(`Match ${index + 1} (#${match.matchNumber}):`, {
        scheduledTime: match.scheduledTime,
        typeof: typeof match.scheduledTime,
        isDate: match.scheduledTime instanceof Date,
        stringValue: String(match.scheduledTime),
      });
    });

    // Format match data for public view
    const formattedMatches = matches.map((match) => ({
      ...match,
      formattedScheduledTime: match.scheduledTime
        ? new Date(match.scheduledTime).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : 'TBD',
      isLive: match.status === 'in-progress',
      isUpcoming: match.status === 'scheduled',
      isCompleted: match.status === 'completed',
    }));

    res.json(formattedMatches);
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch matches',
    });
  }
});

// Get tournament standings for public view
router.get('/tournaments/:id/standings/public', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('registeredTeams', 'name grade sex levelOfCompetition')
      .lean();

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // Get all matches for this tournament
    const matches = await Match.find({
      tournament: req.params.id,
      status: 'completed',
    })
      .populate('team1', 'name')
      .populate('team2', 'name')
      .lean();

    // Calculate standings
    const standingsMap = new Map();

    // Initialize all teams
    tournament.registeredTeams.forEach((team) => {
      standingsMap.set(team._id.toString(), {
        team,
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        points: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
      });
    });

    // Process matches
    matches.forEach((match) => {
      if (match.team1 && match.team2) {
        const team1Id = match.team1._id.toString();
        const team2Id = match.team2._id.toString();

        if (standingsMap.has(team1Id) && standingsMap.has(team2Id)) {
          const team1Stats = standingsMap.get(team1Id);
          const team2Stats = standingsMap.get(team2Id);

          // Update matches played
          team1Stats.matchesPlayed++;
          team2Stats.matchesPlayed++;

          // Update goals
          team1Stats.goalsFor += match.team1Score;
          team1Stats.goalsAgainst += match.team2Score;
          team2Stats.goalsFor += match.team2Score;
          team2Stats.goalsAgainst += match.team1Score;

          // Update wins/losses/draws and points
          if (match.team1Score > match.team2Score) {
            team1Stats.wins++;
            team1Stats.points += tournament.settings.pointsPerWin;
            team2Stats.losses++;
            team2Stats.points += tournament.settings.pointsPerLoss;
          } else if (match.team1Score < match.team2Score) {
            team2Stats.wins++;
            team2Stats.points += tournament.settings.pointsPerWin;
            team1Stats.losses++;
            team1Stats.points += tournament.settings.pointsPerLoss;
          } else {
            team1Stats.draws++;
            team2Stats.draws++;
            team1Stats.points += tournament.settings.pointsPerDraw;
            team2Stats.points += tournament.settings.pointsPerDraw;
          }

          // Update goal difference
          team1Stats.goalDifference =
            team1Stats.goalsFor - team1Stats.goalsAgainst;
          team2Stats.goalDifference =
            team2Stats.goalsFor - team2Stats.goalsAgainst;
        }
      }
    });

    // Convert to array and sort
    const standings = Array.from(standingsMap.values())
      .sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.goalDifference !== a.goalDifference)
          return b.goalDifference - a.goalDifference;
        if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
        return a.team.name.localeCompare(b.team.name);
      })
      .map((stats, index) => ({
        ...stats,
        position: index + 1,
      }));

    res.json({
      success: true,
      standings,
      tournament: {
        name: tournament.name,
        format: tournament.format,
        settings: tournament.settings,
      },
    });
  } catch (error) {
    console.error('Error fetching standings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch standings',
    });
  }
});

// Get live matches (for score ticker)
router.get('/matches/live', async (req, res) => {
  try {
    const liveMatches = await Match.find({
      status: 'in-progress',
    })
      .populate('tournament', 'name')
      .populate('team1', 'name')
      .populate('team2', 'name')
      .sort({ scheduledTime: 1 })
      .limit(10)
      .lean();

    res.json({
      success: true,
      matches: liveMatches.map((match) => ({
        ...match,
        tournamentName: match.tournament?.name,
        isLive: true,
      })),
    });
  } catch (error) {
    console.error('Error fetching live matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch live matches',
    });
  }
});

router.get('/tournaments/:id/matches', async (req, res) => {
  try {
    const matches = await Match.find({
      tournament: req.params.id,
      status: { $in: ['scheduled', 'in-progress'] },
    })
      .populate('team1', 'name grade levelOfCompetition')
      .populate('team2', 'name grade levelOfCompetition')
      .sort({ scheduledTime: 1 })
      .lean();

    res.json({
      success: true,
      matches: matches.map((match) => ({
        ...match,
        isLive: match.status === 'in-progress',
        formattedTime: match.scheduledTime
          ? new Date(match.scheduledTime).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
          : 'TBD',
      })),
    });
  } catch (error) {
    console.error('Error fetching matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch matches',
    });
  }
});

module.exports = router;
