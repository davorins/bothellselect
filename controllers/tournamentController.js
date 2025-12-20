// tournamentController.js
const { Tournament, Match, Standing, Team, Parent } = require('../models');
const { validationResult } = require('express-validator');
const mongoose = require('mongoose');

// Export as regular functions (not class)
exports.createTournament = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const tournamentData = {
      ...req.body,
      createdBy: req.user.id,
    };

    const tournament = new Tournament(tournamentData);
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
      message: 'Failed to create tournament',
      error: error.message,
    });
  }
};

exports.getTournaments = async (req, res) => {
  try {
    const {
      status,
      year,
      level,
      page = 1,
      limit = 10,
      sortBy = 'startDate',
      sortOrder = 'desc',
    } = req.query;

    const filter = { isActive: true };

    if (status) filter.status = status;
    if (year) filter.year = parseInt(year);
    if (level && level !== 'All') filter.levelOfCompetition = level;

    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const tournaments = await Tournament.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('registeredTeams', 'name grade levelOfCompetition')
      .populate('createdBy', 'firstName lastName email');

    const total = await Tournament.countDocuments(filter);

    res.json({
      success: true,
      tournaments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching tournaments:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournaments',
      error: error.message,
    });
  }
};

exports.getTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('registeredTeams')
      .populate('createdBy', 'firstName lastName email');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const matches = await Match.find({ tournament: tournament._id })
      .populate('team1 team2 winner loser referee')
      .sort({ round: 1, matchNumber: 1 });

    let standings = [];
    if (tournament.status !== 'draft' && tournament.status !== 'open') {
      standings = await Standing.find({ tournament: tournament._id })
        .populate('team')
        .sort({ points: -1, pointsDifference: -1 });
    }

    res.json({
      success: true,
      tournament,
      matches,
      standings,
    });
  } catch (error) {
    console.error('Error fetching tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament',
      error: error.message,
    });
  }
};

exports.updateTournament = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    if (
      tournament.createdBy.toString() !== req.user.id &&
      req.user.role !== 'admin'
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to update this tournament',
      });
    }

    const updates = {
      ...req.body,
      updatedBy: req.user.id,
    };

    Object.assign(tournament, updates);
    await tournament.save();

    res.json({
      success: true,
      message: 'Tournament updated successfully',
      tournament,
    });
  } catch (error) {
    console.error('Error updating tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update tournament',
      error: error.message,
    });
  }
};

exports.deleteTournament = async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    if (
      tournament.createdBy.toString() !== req.user.id &&
      req.user.role !== 'admin'
    ) {
      return res.status(403).json({
        success: false,
        message: 'Not authorized to delete this tournament',
      });
    }

    tournament.isActive = false;
    await tournament.save();

    res.json({
      success: true,
      message: 'Tournament deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete tournament',
      error: error.message,
    });
  }
};

exports.addTeamToTournament = async (req, res) => {
  try {
    const { tournamentId, teamId } = req.params;

    console.log(`➕ Adding team ${teamId} to tournament ${tournamentId}`);

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found',
      });
    }

    // Check if team is already registered for this tournament
    const alreadyRegistered = team.tournaments?.some(
      (t) => t.tournament === tournament.name && t.year === tournament.year
    );

    if (alreadyRegistered) {
      console.log(
        `⚠️ Team ${team.name} is already registered for ${tournament.name}`
      );
      return res.status(400).json({
        success: false,
        message: 'Team is already registered for this tournament',
      });
    }

    // Check tournament capacity
    if (tournament.registeredTeams.length >= tournament.maxTeams) {
      console.log(
        `❌ Tournament at capacity: ${tournament.registeredTeams.length}/${tournament.maxTeams}`
      );
      return res.status(400).json({
        success: false,
        message: 'Tournament is at maximum capacity',
      });
    }

    // Add tournament to team's tournaments array
    const tournamentRegistration = {
      tournament: tournament.name,
      year: tournament.year,
      registrationDate: new Date(),
      levelOfCompetition: tournament.levelOfCompetition,
      paymentComplete: false,
      paymentStatus: 'pending',
      amountPaid: 0,
    };

    if (!team.tournaments) {
      team.tournaments = [];
    }

    team.tournaments.push(tournamentRegistration);
    team.tournament = tournament.name; // Update main tournament field
    await team.save();

    console.log(`✅ Added tournament registration to team ${team.name}`);

    // Add team to tournament's registered teams (if not already there)
    if (!tournament.registeredTeams.includes(teamId)) {
      tournament.registeredTeams.push(teamId);
      await tournament.save();
      console.log(
        `✅ Added team ${team.name} to tournament ${tournament.name}`
      );
    }

    res.json({
      success: true,
      message: 'Team added to tournament successfully',
      tournament: {
        _id: tournament._id,
        name: tournament.name,
        registeredTeams: tournament.registeredTeams,
      },
      team: {
        _id: team._id,
        name: team.name,
        tournaments: team.tournaments,
      },
    });
  } catch (error) {
    console.error('❌ Error adding team to tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add team to tournament',
      error: error.message,
    });
  }
};

exports.removeTeamFromTournament = async (req, res) => {
  try {
    const { tournamentId, teamId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const team = await Team.findById(teamId);
    if (!team) {
      return res.status(404).json({
        success: false,
        message: 'Team not found',
      });
    }

    if (tournament.status === 'ongoing' || tournament.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot remove teams from an ongoing or completed tournament',
      });
    }

    team.tournaments = team.tournaments.filter(
      (t) => !(t.tournament === tournament.name && t.year === tournament.year)
    );

    if (team.tournaments.length === 0) {
      team.tournament = '';
    }

    await team.save();

    tournament.registeredTeams = tournament.registeredTeams.filter(
      (id) => id.toString() !== teamId
    );
    await tournament.save();

    res.json({
      success: true,
      message: 'Team removed from tournament successfully',
      tournament,
      team,
    });
  } catch (error) {
    console.error('Error removing team from tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to remove team from tournament',
      error: error.message,
    });
  }
};

exports.generateBrackets = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { format } = req.body;

    const tournament =
      await Tournament.findById(tournamentId).populate('registeredTeams');

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    if (tournament.registeredTeams.length < tournament.minTeams) {
      return res.status(400).json({
        success: false,
        message: `Minimum ${tournament.minTeams} teams required, only ${tournament.registeredTeams.length} registered`,
      });
    }

    const existingMatches = await Match.find({ tournament: tournamentId });
    if (existingMatches.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Brackets already generated for this tournament',
      });
    }

    let matches = [];

    switch (format || tournament.format) {
      case 'single-elimination':
        matches = await generateSingleEliminationBracket(tournament);
        break;
      case 'double-elimination':
        matches = await generateDoubleEliminationBracket(tournament);
        break;
      case 'round-robin':
        matches = await generateRoundRobinSchedule(tournament);
        break;
      case 'group-stage':
        matches = await generateGroupStage(tournament);
        break;
      default:
        throw new Error('Invalid tournament format');
    }

    tournament.status = 'open';
    tournament.updatedBy = req.user.id;
    await tournament.save();

    res.json({
      success: true,
      message: 'Tournament brackets generated successfully',
      matches: matches.length,
      tournament,
    });
  } catch (error) {
    console.error('Error generating brackets:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate brackets',
      error: error.message,
    });
  }
};

// Helper function for single elimination bracket
const generateSingleEliminationBracket = async (tournament) => {
  const teams = tournament.registeredTeams;
  const numTeams = teams.length;
  const nextPowerOfTwo = Math.pow(2, Math.ceil(Math.log2(numTeams)));
  const byes = nextPowerOfTwo - numTeams;

  const matches = [];
  let matchNumber = 1;
  let round = 1;

  const firstRoundMatches = [];
  for (let i = 0; i < nextPowerOfTwo / 2; i++) {
    const team1 = i * 2 < numTeams ? teams[i * 2]._id : null;
    const team2 = i * 2 + 1 < numTeams ? teams[i * 2 + 1]._id : null;

    const match = new Match({
      tournament: tournament._id,
      round,
      matchNumber: matchNumber++,
      team1,
      team2,
      status:
        team1 && team2 ? 'scheduled' : team1 ? 'bye' : team2 ? 'bye' : null,
    });

    await match.save();
    matches.push(match);
    firstRoundMatches.push(match);
  }

  let currentRoundMatches = firstRoundMatches;
  while (currentRoundMatches.length > 1) {
    round++;
    const nextRoundMatches = [];

    for (let i = 0; i < currentRoundMatches.length; i += 2) {
      const match1 = currentRoundMatches[i];
      const match2 = currentRoundMatches[i + 1];

      const match = new Match({
        tournament: tournament._id,
        round,
        matchNumber: matchNumber++,
        status: 'scheduled',
      });

      await match.save();
      matches.push(match);
      nextRoundMatches.push(match);

      if (match1) {
        match1.nextMatch = match._id;
        await match1.save();
      }
      if (match2) {
        match2.nextMatch = match._id;
        await match2.save();
      }
    }

    currentRoundMatches = nextRoundMatches;
  }

  return matches;
};

// Helper function for round robin
const generateRoundRobinSchedule = async (tournament) => {
  const teams = tournament.registeredTeams;
  const matches = [];
  let matchNumber = 1;

  for (let i = 0; i < teams.length; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const match = new Match({
        tournament: tournament._id,
        round: 1,
        matchNumber: matchNumber++,
        team1: teams[i]._id,
        team2: teams[j]._id,
        status: 'scheduled',
      });

      await match.save();
      matches.push(match);
    }
  }

  return matches;
};

// Helper function for group stage
const generateGroupStage = async (tournament) => {
  const teams = tournament.registeredTeams;
  const numTeams = teams.length;
  const groups = Math.ceil(numTeams / 4);
  const matches = [];

  const shuffledTeams = [...teams].sort(() => Math.random() - 0.5);

  for (let g = 0; g < groups; g++) {
    const groupName = String.fromCharCode(65 + g);
    const groupTeams = shuffledTeams.slice(g * 4, (g + 1) * 4);

    tournament.groups.push({
      name: groupName,
      teams: groupTeams.map((t) => t._id),
    });

    let matchNumber = 1;
    for (let i = 0; i < groupTeams.length; i++) {
      for (let j = i + 1; j < groupTeams.length; j++) {
        const match = new Match({
          tournament: tournament._id,
          round: 1,
          matchNumber: matchNumber++,
          team1: groupTeams[i]._id,
          team2: groupTeams[j]._id,
          group: groupName,
          status: 'scheduled',
        });

        await match.save();
        matches.push(match);
      }
    }
  }

  await tournament.save();
  return matches;
};

// Helper function for double elimination (simplified)
const generateDoubleEliminationBracket = async (tournament) => {
  const teams = tournament.registeredTeams;
  const numTeams = teams.length;
  const matches = [];
  let matchNumber = 1;

  // Create winners bracket
  const winnersMatches = [];
  for (
    let round = 1;
    Math.ceil(numTeams / Math.pow(2, round - 1)) > 1;
    round++
  ) {
    const roundMatches = [];
    const matchesInRound = Math.ceil(numTeams / Math.pow(2, round));

    for (let i = 0; i < matchesInRound; i++) {
      const match = new Match({
        tournament: tournament._id,
        round,
        matchNumber: matchNumber++,
        bracketType: 'winners',
        bracketLocation: 'upper',
        status: 'scheduled',
      });

      await match.save();
      matches.push(match);
      roundMatches.push(match);
      winnersMatches.push(match);
    }
  }

  // Create losers bracket
  const losersRound = winnersMatches.length;
  for (let i = 0; i < Math.floor(winnersMatches.length / 2); i++) {
    const match = new Match({
      tournament: tournament._id,
      round: losersRound + 1,
      matchNumber: matchNumber++,
      bracketType: 'losers',
      bracketLocation: 'lower',
      status: 'scheduled',
      isConsolation: true,
    });

    await match.save();
    matches.push(match);
  }

  return matches;
};

exports.updateMatch = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { team1Score, team2Score, winner, status, notes, walkoverReason } =
      req.body;

    const match = await Match.findById(matchId).populate(
      'team1 team2 tournament'
    );

    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    if (match.status === 'completed' || match.status === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update a completed or cancelled match',
      });
    }

    match.team1Score = team1Score !== undefined ? team1Score : match.team1Score;
    match.team2Score = team2Score !== undefined ? team2Score : match.team2Score;
    match.status = status || 'completed';
    match.notes = notes;
    match.walkoverReason = walkoverReason;

    if (!winner && team1Score !== undefined && team2Score !== undefined) {
      if (team1Score > team2Score) {
        match.winner = match.team1._id;
        match.loser = match.team2._id;
      } else if (team2Score > team1Score) {
        match.winner = match.team2._id;
        match.loser = match.team1._id;
      }
    } else if (winner) {
      match.winner = winner;
      match.loser =
        winner === match.team1._id ? match.team2._id : match.team1._id;
    }

    match.actualEndTime = new Date();
    await match.save();

    if (match.group) {
      await updateGroupStandings(match);
    }

    if (match.nextMatch && match.winner) {
      const nextMatch = await Match.findById(match.nextMatch);
      if (nextMatch) {
        if (!nextMatch.team1) {
          nextMatch.team1 = match.winner;
        } else if (!nextMatch.team2) {
          nextMatch.team2 = match.winner;
        }
        await nextMatch.save();
      }
    }

    res.json({
      success: true,
      message: 'Match result updated successfully',
      match,
    });
  } catch (error) {
    console.error('Error updating match:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update match',
      error: error.message,
    });
  }
};

// Helper function for standings
const updateGroupStandings = async (match) => {
  if (!match.tournament || !match.group || match.status !== 'completed') {
    return;
  }

  const tournament = await Tournament.findById(match.tournament._id);
  if (!tournament) return;

  const updateStanding = async (
    teamId,
    isWinner,
    isDraw,
    pointsFor,
    pointsAgainst
  ) => {
    let standing = await Standing.findOne({
      tournament: tournament._id,
      team: teamId,
      group: match.group,
    });

    if (!standing) {
      standing = new Standing({
        tournament: tournament._id,
        team: teamId,
        group: match.group,
        played: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        pointsFor: 0,
        pointsAgainst: 0,
        points: 0,
      });
    }

    standing.played += 1;

    if (isDraw) {
      standing.draws += 1;
      standing.points += tournament.settings.pointsPerDraw;
    } else if (isWinner) {
      standing.wins += 1;
      standing.points += tournament.settings.pointsPerWin;
    } else {
      standing.losses += 1;
      standing.points += tournament.settings.pointsPerLoss;
    }

    standing.pointsFor += pointsFor;
    standing.pointsAgainst += pointsAgainst;
    await standing.save();
  };

  const isDraw = match.team1Score === match.team2Score;
  const team1Wins = match.team1Score > match.team2Score;
  const team2Wins = match.team2Score > match.team1Score;

  await updateStanding(
    match.team1._id,
    team1Wins,
    isDraw,
    match.team1Score,
    match.team2Score
  );
  await updateStanding(
    match.team2._id,
    team2Wins,
    isDraw,
    match.team2Score,
    match.team1Score
  );

  await updateGroupRanks(tournament._id, match.group);
};

const updateGroupRanks = async (tournamentId, group) => {
  const standings = await Standing.find({
    tournament: tournamentId,
    group: group,
  }).sort({ points: -1, pointsDifference: -1, pointsFor: -1 });

  for (let i = 0; i < standings.length; i++) {
    standings[i].rank = i + 1;
    await standings[i].save();
  }
};

exports.startTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    if (tournament.status !== 'open') {
      return res.status(400).json({
        success: false,
        message: `Tournament cannot be started from ${tournament.status} status`,
      });
    }

    const matchCount = await Match.countDocuments({
      tournament: tournamentId,
    });
    if (matchCount === 0) {
      return res.status(400).json({
        success: false,
        message: 'No matches scheduled for this tournament',
      });
    }

    tournament.status = 'ongoing';
    tournament.updatedBy = req.user.id;
    await tournament.save();

    res.json({
      success: true,
      message: 'Tournament started successfully',
      tournament,
    });
  } catch (error) {
    console.error('Error starting tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to start tournament',
      error: error.message,
    });
  }
};

exports.completeTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    if (tournament.status !== 'ongoing') {
      return res.status(400).json({
        success: false,
        message: `Tournament cannot be completed from ${tournament.status} status`,
      });
    }

    const pendingMatches = await Match.countDocuments({
      tournament: tournamentId,
      status: { $in: ['scheduled', 'in-progress'] },
    });

    if (pendingMatches > 0) {
      return res.status(400).json({
        success: false,
        message: `${pendingMatches} matches still pending. Complete all matches before finishing the tournament.`,
      });
    }

    tournament.status = 'completed';
    tournament.updatedBy = req.user.id;
    await tournament.save();

    res.json({
      success: true,
      message: 'Tournament completed successfully',
      tournament,
    });
  } catch (error) {
    console.error('Error completing tournament:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete tournament',
      error: error.message,
    });
  }
};

exports.getStandings = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const standings = await Standing.find({ tournament: tournamentId })
      .populate('team', 'name grade levelOfCompetition')
      .sort({ group: 1, points: -1, pointsDifference: -1, pointsFor: -1 });

    res.json({
      success: true,
      standings,
    });
  } catch (error) {
    console.error('Error fetching standings:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch standings',
      error: error.message,
    });
  }
};

exports.getSchedule = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { date, court, status } = req.query;

    const filter = { tournament: tournamentId };
    if (date) {
      const startDate = new Date(date);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(date);
      endDate.setHours(23, 59, 59, 999);
      filter.scheduledTime = { $gte: startDate, $lte: endDate };
    }
    if (court) filter.court = court;
    if (status) filter.status = status;

    const matches = await Match.find(filter)
      .populate('team1 team2 referee')
      .sort({ scheduledTime: 1, court: 1 });

    res.json({
      success: true,
      matches,
    });
  } catch (error) {
    console.error('Error fetching schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch schedule',
      error: error.message,
    });
  }
};

exports.getEligibleTeams = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    console.log(`🔍 Fetching eligible teams for tournament: ${tournamentId}`);

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // First, get currently registered teams
    const registeredTeamIds = tournament.registeredTeams || [];

    // Build filter for eligible teams
    const filter = {
      isActive: true,
      _id: { $nin: registeredTeamIds }, // Exclude already registered teams
    };

    // Filter by competition level
    if (tournament.levelOfCompetition !== 'All') {
      filter.levelOfCompetition = tournament.levelOfCompetition;
    }

    // Filter by gender
    if (tournament.sex !== 'Mixed') {
      filter.sex = tournament.sex;
    }

    // Also exclude teams already registered for this tournament (by name/year)
    const additionalFilter = {
      $or: [
        // Teams not registered for any tournament
        { tournaments: { $size: 0 } },
        // Teams not registered for THIS specific tournament
        {
          $and: [
            { 'tournaments.tournament': { $ne: tournament.name } },
            { 'tournaments.year': { $ne: tournament.year } },
          ],
        },
      ],
    };

    // Combine filters
    const finalFilter = { ...filter, ...additionalFilter };

    console.log(
      '🔍 Filter for eligible teams:',
      JSON.stringify(finalFilter, null, 2)
    );

    const eligibleTeams = await Team.find(finalFilter)
      .select('name grade sex levelOfCompetition coachIds tournaments isActive')
      .populate('coachIds', 'firstName lastName email')
      .sort({ name: 1 });

    console.log(`✅ Found ${eligibleTeams.length} eligible teams`);

    res.json({
      success: true,
      teams: eligibleTeams,
      tournament: {
        name: tournament.name,
        year: tournament.year,
        levelOfCompetition: tournament.levelOfCompetition,
        sex: tournament.sex,
        registeredCount: registeredTeamIds.length,
        maxTeams: tournament.maxTeams,
      },
    });
  } catch (error) {
    console.error('❌ Error fetching eligible teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch eligible teams',
      error: error.message,
    });
  }
};

exports.generateSchedule = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { startDate, endDate, startTime, endTime, courts } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const matches = await Match.find({
      tournament: tournamentId,
      scheduledTime: { $exists: false },
    });

    if (matches.length === 0) {
      return res.json({
        success: true,
        message: 'All matches are already scheduled',
        matches: [],
      });
    }

    const startDateTime = new Date(startDate);
    const endDateTime = new Date(endDate);
    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);

    const scheduledMatches = [];
    let currentDate = new Date(startDateTime);
    let matchIndex = 0;

    while (currentDate <= endDateTime && matchIndex < matches.length) {
      let currentTime = new Date(currentDate);
      currentTime.setHours(startHour, startMinute, 0, 0);

      const dayEnd = new Date(currentDate);
      dayEnd.setHours(endHour, endMinute, 0, 0);

      let courtIndex = 0;

      while (currentTime < dayEnd && matchIndex < matches.length) {
        const match = matches[matchIndex];
        match.scheduledTime = new Date(currentTime);
        match.court = courts[courtIndex % courts.length];
        await match.save();

        scheduledMatches.push(match);

        currentTime.setMinutes(
          currentTime.getMinutes() +
            tournament.settings.matchDuration +
            tournament.settings.breakDuration
        );
        matchIndex++;
        courtIndex++;
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    res.json({
      success: true,
      message: `Scheduled ${scheduledMatches.length} matches`,
      matches: scheduledMatches,
    });
  } catch (error) {
    console.error('Error generating schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate schedule',
      error: error.message,
    });
  }
};

exports.getRegisteredTeams = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    console.log(`🔄 Fetching registered teams for tournament: ${tournamentId}`);

    // First, get the tournament with populated registeredTeams
    const tournament = await Tournament.findById(tournamentId)
      .populate(
        'registeredTeams',
        'name grade sex levelOfCompetition coachIds isActive tournament tournaments'
      )
      .lean();

    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    console.log(`✅ Tournament found: ${tournament.name}`);
    console.log(
      `📊 Tournament has ${tournament.registeredTeams?.length || 0} registered teams in array`
    );

    // Method 1: Return teams from tournament's registeredTeams array (populated)
    if (tournament.registeredTeams && tournament.registeredTeams.length > 0) {
      console.log('✅ Returning teams from tournament.registeredTeams array');
      return res.json({
        success: true,
        teams: tournament.registeredTeams,
        source: 'tournament_registeredTeams',
      });
    }

    // Method 2: If no teams in array, search for teams that mention this tournament
    console.log(
      '🔄 No teams in registeredTeams array, searching in Team collection...'
    );

    // Get tournament details
    const tournamentDetails = await Tournament.findById(tournamentId).lean();

    // Search for teams in two ways:
    const teamsByTournamentName = await Team.find({
      $or: [
        // Teams with main tournament field matching
        { tournament: tournamentDetails.name },
        // Teams with tournament in tournaments array
        {
          'tournaments.tournament': tournamentDetails.name,
          'tournaments.year': tournamentDetails.year,
        },
      ],
      isActive: true,
    })
      .select(
        'name grade sex levelOfCompetition coachIds isActive tournament tournaments'
      )
      .populate('coachIds', 'firstName lastName email');

    console.log(
      `🔍 Found ${teamsByTournamentName.length} teams by tournament name search`
    );

    if (teamsByTournamentName.length > 0) {
      // Update tournament's registeredTeams array with these team IDs
      await Tournament.findByIdAndUpdate(tournamentId, {
        $set: {
          registeredTeams: teamsByTournamentName.map((team) => team._id),
        },
      });

      console.log(
        `✅ Updated tournament with ${teamsByTournamentName.length} team IDs`
      );

      return res.json({
        success: true,
        teams: teamsByTournamentName,
        source: 'team_collection_search',
      });
    }

    // Method 3: Get all active teams and filter by grade/level
    console.log('🔄 No teams found by name, fetching all active teams...');
    const allActiveTeams = await Team.find({ isActive: true })
      .select(
        'name grade sex levelOfCompetition coachIds isActive tournament tournaments'
      )
      .populate('coachIds', 'firstName lastName email');

    // Filter teams that match tournament criteria
    const eligibleTeams = allActiveTeams.filter((team) => {
      // Check if team matches tournament criteria
      const levelMatch =
        tournamentDetails.levelOfCompetition === 'All' ||
        team.levelOfCompetition === tournamentDetails.levelOfCompetition;

      const sexMatch =
        tournamentDetails.sex === 'Mixed' || team.sex === tournamentDetails.sex;

      // Check if team is already registered (by name/year)
      const alreadyRegistered = team.tournaments?.some(
        (t) =>
          t.tournament === tournamentDetails.name &&
          t.year === tournamentDetails.year
      );

      return levelMatch && sexMatch && !alreadyRegistered;
    });

    console.log(
      `🎯 Found ${eligibleTeams.length} eligible teams for ${tournamentDetails.name}`
    );

    return res.json({
      success: true,
      teams: eligibleTeams,
      source: 'all_teams_filtered',
    });
  } catch (error) {
    console.error('❌ Error fetching registered teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch registered teams',
      error: error.message,
    });
  }
};

exports.createManualBracket = async (req, res) => {
  try {
    const { tournamentId, round } = req.params;
    const { matches } = req.body;

    console.log('Creating manual bracket:', {
      tournamentId,
      round: round,
      matchesCount: matches?.length,
    });

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // Validate matches data
    if (!matches || !Array.isArray(matches)) {
      return res.status(400).json({
        success: false,
        message: 'Matches array is required',
      });
    }

    // Validate round - parse it from string to number
    const roundNumber = parseInt(round);
    if (isNaN(roundNumber) || roundNumber < 1) {
      return res.status(400).json({
        success: false,
        message: 'Valid round number is required',
      });
    }

    const createdMatches = [];
    let matchNumber = 1;

    // Get the next match number
    const existingMatches = await Match.find({
      tournament: tournamentId,
      round: roundNumber,
    }).sort({ matchNumber: -1 });

    if (existingMatches.length > 0) {
      matchNumber = existingMatches[0].matchNumber + 1;
    }

    for (const matchData of matches) {
      // Ensure required fields
      const matchDoc = new Match({
        tournament: tournamentId,
        round: roundNumber, // Use parsed round number
        matchNumber: matchNumber++,
        team1: matchData.team1 || null,
        team2: matchData.team2 || null,
        status: matchData.team1 && matchData.team2 ? 'scheduled' : 'bye',
        bracketType: matchData.bracketType || 'winners',
        team1Score: 0,
        team2Score: 0,
      });

      await matchDoc.save();
      createdMatches.push(matchDoc);
    }

    // Update tournament status if needed
    if (tournament.status === 'draft') {
      tournament.status = 'open';
      await tournament.save();
    }

    res.json({
      success: true,
      message: 'Bracket created successfully',
      matches: createdMatches,
    });
  } catch (error) {
    console.error('Error creating manual bracket:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create bracket',
      error: error.message,
    });
  }
};

exports.updateMatchTeams = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { team1, team2, position } = req.body;

    const match = await Match.findById(matchId).populate('tournament');
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    const tournament = await Tournament.findById(match.tournament._id);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    if (team1 && !tournament.registeredTeams.includes(team1)) {
      return res.status(400).json({
        success: false,
        message: 'Team 1 is not registered for this tournament',
      });
    }

    if (team2 && !tournament.registeredTeams.includes(team2)) {
      return res.status(400).json({
        success: false,
        message: 'Team 2 is not registered for this tournament',
      });
    }

    if (position === 'team1') {
      match.team1 = team1;
    } else if (position === 'team2') {
      match.team2 = team2;
    } else {
      match.team1 = team1;
      match.team2 = team2;
    }

    if (match.team1 && match.team2) {
      match.status = 'scheduled';
    } else if (match.team1 || match.team2) {
      match.status = 'bye';
    } else {
      match.status = 'scheduled';
    }

    await match.save();

    res.json({
      success: true,
      message: 'Match updated successfully',
      match,
    });
  } catch (error) {
    console.error('Error updating match teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update match',
      error: error.message,
    });
  }
};

exports.getBracketMatches = async (req, res) => {
  try {
    const { tournamentId, round } = req.params;

    console.log(
      `🔍 Fetching bracket matches for tournament ${tournamentId}, round ${round}`
    );

    const matches = await Match.find({
      tournament: tournamentId,
      round: parseInt(round),
    })
      .populate('team1 team2 winner loser')
      .sort({ matchNumber: 1 });

    console.log(`✅ Found ${matches.length} matches for round ${round}`);

    res.json({
      success: true,
      matches,
    });
  } catch (error) {
    console.error('Error fetching bracket matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch bracket matches',
      error: error.message,
    });
  }
};

exports.clearRoundMatches = async (req, res) => {
  try {
    const { tournamentId, round } = req.params;

    await Match.deleteMany({
      tournament: tournamentId,
      round: parseInt(round),
    });

    res.json({
      success: true,
      message: `Round ${round} matches cleared successfully`,
    });
  } catch (error) {
    console.error('Error clearing round matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to clear round matches',
      error: error.message,
    });
  }
};

exports.addTeamsToTournamentBatch = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { teamIds } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const results = {
      added: [],
      failed: [],
      skipped: [],
    };

    for (const teamId of teamIds) {
      try {
        const team = await Team.findById(teamId);
        if (!team) {
          results.failed.push({ teamId, reason: 'Team not found' });
          continue;
        }

        const alreadyRegistered = team.tournaments.some(
          (t) => t.tournament === tournament.name && t.year === tournament.year
        );

        if (alreadyRegistered) {
          results.skipped.push({
            teamId,
            name: team.name,
            reason: 'Already registered',
          });
          continue;
        }

        if (tournament.registeredTeams.length >= tournament.maxTeams) {
          results.failed.push({
            teamId,
            name: team.name,
            reason: 'Tournament at capacity',
          });
          break;
        }

        team.tournaments.push({
          tournament: tournament.name,
          year: tournament.year,
          registrationDate: new Date(),
          levelOfCompetition: tournament.levelOfCompetition,
          paymentComplete: true,
          paymentStatus: 'paid',
          amountPaid: 0,
        });

        team.tournament = tournament.name;
        await team.save();

        tournament.registeredTeams.push(teamId);
        results.added.push({ teamId, name: team.name });
      } catch (error) {
        results.failed.push({ teamId, reason: error.message });
      }
    }

    await tournament.save();

    res.json({
      success: true,
      message: `Added ${results.added.length} teams, skipped ${results.skipped.length}, failed ${results.failed.length}`,
      results,
      tournament,
    });
  } catch (error) {
    console.error('Error adding teams batch:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to add teams',
      error: error.message,
    });
  }
};

// ============================================
// BRACKET PROGRESSION METHODS
// ============================================

/**
 * Get tournament bracket progress
 */
exports.getTournamentProgress = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    console.log(`📊 Getting progress for tournament: ${tournamentId}`);

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // Get all matches grouped by round
    const matches = await Match.find({ tournament: tournamentId })
      .sort({ round: 1, matchNumber: 1 })
      .populate('team1 team2 winner loser');

    console.log(`📋 Found ${matches.length} total matches`);

    // Group matches by round
    const matchesByRound = {};
    matches.forEach((match) => {
      if (!matchesByRound[match.round]) {
        matchesByRound[match.round] = [];
      }
      matchesByRound[match.round].push(match);
    });

    // Calculate progress for each round
    const rounds = Object.keys(matchesByRound)
      .map(Number)
      .sort((a, b) => a - b);
    const progress = rounds.map((round) => {
      const roundMatches = matchesByRound[round];
      const completedMatches = roundMatches.filter(
        (m) => m.status === 'completed' || m.status === 'walkover'
      );

      const winningTeams = roundMatches
        .filter((m) => m.winner && m.winner._id)
        .map((m) => ({
          _id: m.winner._id,
          name: m.winner.name,
          matchId: m._id,
        }));

      return {
        round,
        totalMatches: roundMatches.length,
        completedMatches: completedMatches.length,
        completionPercentage:
          roundMatches.length > 0
            ? Math.round((completedMatches.length / roundMatches.length) * 100)
            : 0,
        winningTeamsCount: winningTeams.length,
        isComplete:
          completedMatches.length === roundMatches.length &&
          roundMatches.length > 0,
        winningTeams: winningTeams,
        hasByes: roundMatches.some((m) => m.status === 'bye'),
      };
    });

    // Get current active round (first incomplete round or last round if all complete)
    let currentRound = 1;
    const incompleteRound = progress.find((p) => !p.isComplete);
    if (incompleteRound) {
      currentRound = incompleteRound.round;
    } else if (progress.length > 0) {
      currentRound = progress[progress.length - 1].round;
    }

    // Get winning teams for current round
    const currentRoundMatches = matchesByRound[currentRound] || [];
    const currentWinningTeams = currentRoundMatches
      .filter((match) => match.winner)
      .map((match) => match.winner._id);

    // Check if all matches in current round have winners
    const allMatchesHaveWinners =
      currentRoundMatches.length > 0 &&
      currentRoundMatches.every(
        (match) =>
          match.winner || match.status === 'bye' || match.status === 'cancelled'
      );

    // Determine if next round can be created
    const nextRound = currentRound + 1;
    const nextRoundExists = matchesByRound[nextRound]?.length > 0;
    const canAdvance = allMatchesHaveWinners && !nextRoundExists;
    const isFinalRound = currentWinningTeams.length <= 2;

    res.json({
      success: true,
      progress,
      currentRound,
      totalRounds: rounds.length,
      tournamentStatus: tournament.status,
      currentRoundStats: {
        totalMatches: currentRoundMatches.length,
        completedMatches: currentRoundMatches.filter(
          (m) => m.status === 'completed' || m.status === 'walkover'
        ).length,
        winningTeamsCount: currentWinningTeams.length,
        allMatchesHaveWinners,
        canAdvance,
        isFinalRound,
      },
      rounds: rounds,
      nextRound,
      nextRoundExists,
    });
  } catch (error) {
    console.error('❌ Error getting tournament progress:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get tournament progress',
      error: error.message,
    });
  }
};

/**
 * Advance tournament to next round
 */
exports.advanceToNextRound = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { round, autoAssignTeams = true } = req.body;

    console.log(`🚀 Advancing tournament ${tournamentId} from round ${round}`);

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // Get current round matches
    const currentRoundMatches = await Match.find({
      tournament: tournamentId,
      round: parseInt(round),
    })
      .populate('team1 team2 winner loser')
      .sort({ matchNumber: 1 });

    console.log(`📋 Current round has ${currentRoundMatches.length} matches`);

    // Check if all matches have winners
    const incompleteMatches = currentRoundMatches.filter(
      (match) =>
        !match.winner && match.status !== 'bye' && match.status !== 'cancelled'
    );

    if (incompleteMatches.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot advance: ${incompleteMatches.length} matches without winners`,
        incompleteMatches: incompleteMatches.map((m) => ({
          matchId: m._id,
          matchNumber: m.matchNumber,
          teams: `${m.team1?.name || 'TBD'} vs ${m.team2?.name || 'TBD'}`,
        })),
      });
    }

    // Get winning teams
    const winningTeams = currentRoundMatches
      .filter((match) => match.winner)
      .map((match) => match.winner);

    // Include bye teams as winners
    const byeTeams = currentRoundMatches
      .filter((match) => match.status === 'bye')
      .map((match) => match.team1 || match.team2)
      .filter((team) => team);

    const allWinners = [...winningTeams, ...byeTeams].filter((team) => team);

    console.log(
      `🏆 Found ${allWinners.length} winning/by teams:`,
      allWinners.map((t) => t.name)
    );

    if (allWinners.length < 2) {
      return res.status(400).json({
        success: false,
        message: `Need at least 2 winning teams to advance. Only ${allWinners.length} winners found.`,
      });
    }

    // Check if next round already exists
    const nextRound = parseInt(round) + 1;
    const existingNextRoundMatches = await Match.find({
      tournament: tournamentId,
      round: nextRound,
    });

    if (existingNextRoundMatches.length > 0) {
      console.log(
        `⚠️ Round ${nextRound} already exists with ${existingNextRoundMatches.length} matches`
      );
      return res.json({
        success: true,
        message: `Round ${nextRound} already exists`,
        round: nextRound,
        existingMatches: existingNextRoundMatches.length,
        action: 'switched_to_existing_round',
      });
    }

    // Create next round matches
    const numMatches = Math.ceil(allWinners.length / 2);
    const matches = [];
    let matchNumber = 1;

    console.log(`🎯 Creating ${numMatches} matches for round ${nextRound}`);

    // Shuffle winners for random pairing (optional)
    const shuffledWinners = [...allWinners].sort(() => Math.random() - 0.5);

    for (let i = 0; i < numMatches; i++) {
      const team1 = shuffledWinners[i * 2] || null;
      const team2 = shuffledWinners[i * 2 + 1] || null;

      const match = new Match({
        tournament: tournamentId,
        round: nextRound,
        matchNumber: matchNumber++,
        team1: team1?._id || null,
        team2: team2?._id || null,
        bracketType: 'winners',
        status:
          team1 && team2 ? 'scheduled' : team1 || team2 ? 'bye' : 'scheduled',
        team1Score: 0,
        team2Score: 0,
      });

      await match.save();

      // Populate team data for response
      const populatedMatch = await Match.findById(match._id)
        .populate('team1', 'name grade levelOfCompetition sex')
        .populate('team2', 'name grade levelOfCompetition sex');

      matches.push(populatedMatch);
    }

    // Update tournament status if needed
    if (allWinners.length === 2 && tournament.status === 'open') {
      tournament.status = 'ongoing';
      await tournament.save();
      console.log(`🎊 Tournament status updated to 'ongoing' for finals`);
    }

    // Update tournament's current round
    tournament.updatedBy = req.user.id;
    await tournament.save();

    console.log(
      `✅ Successfully created round ${nextRound} with ${matches.length} matches`
    );

    res.json({
      success: true,
      message: `Round ${nextRound} created with ${matches.length} matches`,
      nextRound,
      matchesCreated: matches.length,
      winningTeamsCount: allWinners.length,
      matches: matches,
      tournamentStatus: tournament.status,
      isFinalRound: allWinners.length === 2,
    });
  } catch (error) {
    console.error('❌ Error advancing to next round:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to advance to next round',
      error: error.message,
    });
  }
};

/**
 * Get winning teams for a specific round
 */
exports.getWinningTeams = async (req, res) => {
  try {
    const { tournamentId, round } = req.params;

    console.log(
      `🏆 Getting winning teams for tournament ${tournamentId}, round ${round}`
    );

    const matches = await Match.find({
      tournament: tournamentId,
      round: parseInt(round),
    })
      .populate('winner', 'name grade levelOfCompetition sex coachIds')
      .populate('team1', 'name grade levelOfCompetition sex')
      .populate('team2', 'name grade levelOfCompetition sex')
      .populate('loser', 'name')
      .sort({ matchNumber: 1 });

    const winningTeams = matches
      .filter((match) => match.winner)
      .map((match) => ({
        team: match.winner,
        matchId: match._id,
        matchNumber: match.matchNumber,
        opponent:
          match.winner._id.toString() === match.team1?._id?.toString()
            ? match.team2
            : match.team1,
        score: {
          team1: match.team1Score,
          team2: match.team2Score,
        },
        status: match.status,
        isWalkover: match.status === 'walkover',
        walkoverReason: match.walkoverReason,
      }));

    // Also include bye teams as winners
    const byeTeams = matches
      .filter((match) => match.status === 'bye')
      .map((match) => ({
        team: match.team1 || match.team2,
        matchId: match._id,
        matchNumber: match.matchNumber,
        opponent: null,
        score: { team1: 0, team2: 0 },
        status: 'bye',
        isWalkover: false,
        walkoverReason: 'Bye',
      }))
      .filter((item) => item.team);

    const allWinners = [...winningTeams, ...byeTeams];

    console.log(`✅ Found ${allWinners.length} winning/by teams`);

    res.json({
      success: true,
      winningTeams: allWinners,
      count: allWinners.length,
      round: parseInt(round),
    });
  } catch (error) {
    console.error('❌ Error getting winning teams:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get winning teams',
      error: error.message,
    });
  }
};

/**
 * Complete a specific round (mark all matches as ready for next round)
 */
exports.completeRound = async (req, res) => {
  try {
    const { tournamentId, round } = req.params;
    const { force = false } = req.body;

    console.log(`🎯 Completing round ${round} for tournament ${tournamentId}`);

    const matches = await Match.find({
      tournament: tournamentId,
      round: parseInt(round),
    }).populate('team1 team2 winner');

    if (matches.length === 0) {
      return res.status(404).json({
        success: false,
        message: `No matches found for round ${round}`,
      });
    }

    // Check if all matches have winners
    const incompleteMatches = matches.filter(
      (match) =>
        !match.winner && match.status !== 'bye' && match.status !== 'cancelled'
    );

    if (!force && incompleteMatches.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Cannot complete round: ${incompleteMatches.length} matches without winners`,
        incompleteMatches: incompleteMatches.map((m) => ({
          matchId: m._id,
          matchNumber: m.matchNumber,
          teams: `${m.team1?.name || 'TBD'} vs ${m.team2?.name || 'TBD'}`,
          status: m.status,
        })),
      });
    }

    // Get all winning teams
    const winningTeams = matches
      .filter((match) => match.winner)
      .map((match) => match.winner._id);

    // Count bye matches
    const byeMatches = matches.filter((match) => match.status === 'bye').length;

    res.json({
      success: true,
      message: `Round ${round} is ready for advancement`,
      round: parseInt(round),
      totalMatches: matches.length,
      completedMatches: matches.length - incompleteMatches.length,
      incompleteMatches: incompleteMatches.length,
      winningTeamsCount: winningTeams.length,
      byeMatches,
      canAdvance: winningTeams.length >= 2,
    });
  } catch (error) {
    console.error('❌ Error completing round:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to complete round',
      error: error.message,
    });
  }
};

/**
 * Reset match to allow re-declaring winner
 */
exports.resetMatch = async (req, res) => {
  try {
    const { matchId } = req.params;

    console.log(`🔄 Resetting match ${matchId}`);

    const match = await Match.findById(matchId).populate('tournament');
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    // Check if tournament allows resetting
    const tournament = await Tournament.findById(match.tournament);
    if (tournament.status === 'completed') {
      return res.status(400).json({
        success: false,
        message: 'Cannot reset matches in completed tournament',
      });
    }

    // Reset match data
    match.winner = null;
    match.loser = null;
    match.team1Score = 0;
    match.team2Score = 0;
    match.status = match.team1 && match.team2 ? 'scheduled' : 'bye';
    match.walkoverReason = undefined;
    match.actualEndTime = undefined;

    await match.save();

    // If this match had a nextMatch assigned, clear the team from that match
    if (match.nextMatch) {
      const nextMatch = await Match.findById(match.nextMatch);
      if (nextMatch) {
        // Remove this team from the next match
        if (nextMatch.team1?.toString() === match._id.toString()) {
          nextMatch.team1 = null;
        } else if (nextMatch.team2?.toString() === match._id.toString()) {
          nextMatch.team2 = null;
        }

        // Update next match status
        nextMatch.status =
          nextMatch.team1 && nextMatch.team2 ? 'scheduled' : 'bye';
        await nextMatch.save();
      }
    }

    // If this was a group stage match, update standings
    if (match.group) {
      await updateGroupStandings(match);
    }

    console.log(`✅ Match ${matchId} reset successfully`);

    res.json({
      success: true,
      message: 'Match reset successfully',
      match: await Match.findById(matchId).populate(
        'team1 team2 winner loser tournament'
      ),
    });
  } catch (error) {
    console.error('❌ Error resetting match:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to reset match',
      error: error.message,
    });
  }
};

/**
 * Get round summary
 */
exports.getRoundSummary = async (req, res) => {
  try {
    const { tournamentId, round } = req.params;

    console.log(
      `📋 Getting summary for round ${round}, tournament ${tournamentId}`
    );

    const matches = await Match.find({
      tournament: tournamentId,
      round: parseInt(round),
    })
      .populate('team1 team2 winner loser')
      .sort({ matchNumber: 1 });

    const tournament = await Tournament.findById(tournamentId);

    const summary = {
      round: parseInt(round),
      totalMatches: matches.length,
      scheduledMatches: matches.filter((m) => m.status === 'scheduled').length,
      inProgressMatches: matches.filter((m) => m.status === 'in-progress')
        .length,
      completedMatches: matches.filter((m) => m.status === 'completed').length,
      walkoverMatches: matches.filter((m) => m.status === 'walkover').length,
      byeMatches: matches.filter((m) => m.status === 'bye').length,
      cancelledMatches: matches.filter((m) => m.status === 'cancelled').length,
      matchesWithWinners: matches.filter((m) => m.winner).length,
      matchesWithoutWinners: matches.filter((m) => !m.winner).length,
      isRoundComplete: matches.every(
        (m) => m.winner || m.status === 'bye' || m.status === 'cancelled'
      ),
      canAdvance: matches.filter((m) => m.winner).length >= 2,
      tournamentStatus: tournament?.status || 'unknown',
      nextRound: parseInt(round) + 1,
    };

    // Check if next round exists
    const nextRoundMatches = await Match.find({
      tournament: tournamentId,
      round: parseInt(round) + 1,
    });
    summary.nextRoundExists = nextRoundMatches.length > 0;

    // Get list of winning teams
    summary.winningTeams = matches
      .filter((m) => m.winner)
      .map((m) => ({
        id: m.winner._id,
        name: m.winner.name,
        matchId: m._id,
        matchNumber: m.matchNumber,
      }));

    // Get list of incomplete matches
    summary.incompleteMatches = matches
      .filter(
        (m) => !m.winner && m.status !== 'bye' && m.status !== 'cancelled'
      )
      .map((m) => ({
        matchId: m._id,
        matchNumber: m.matchNumber,
        teams: `${m.team1?.name || 'TBD'} vs ${m.team2?.name || 'TBD'}`,
        status: m.status,
      }));

    console.log(
      `✅ Round summary: ${summary.completedMatches}/${summary.totalMatches} matches completed`
    );

    res.json({
      success: true,
      summary,
    });
  } catch (error) {
    console.error('❌ Error getting round summary:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get round summary',
      error: error.message,
    });
  }
};

/**
 * Quick declare winner (for admin convenience)
 */
exports.quickDeclareWinner = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { winnerId, team1Score, team2Score, isWalkover = false } = req.body;

    console.log(`⚡ Quick declaring winner for match ${matchId}`);
    console.log('Request data:', {
      winnerId,
      team1Score,
      team2Score,
      isWalkover,
    });

    const match = await Match.findById(matchId).populate(
      'team1 team2 tournament'
    );

    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    console.log('Match teams:', {
      team1: match.team1?._id,
      team1Name: match.team1?.name,
      team2: match.team2?._id,
      team2Name: match.team2?.name,
    });

    if (!match.team1 || !match.team2) {
      return res.status(400).json({
        success: false,
        message: 'Both teams must be assigned before declaring a winner',
      });
    }

    // Determine winner and loser
    const winner =
      match.team1._id.toString() === winnerId ? match.team1 : match.team2;
    const loser =
      match.team1._id.toString() === winnerId ? match.team2 : match.team1;

    console.log('Determined:', {
      winnerId: winner._id,
      winnerName: winner.name,
      loserId: loser._id,
      loserName: loser.name,
      isTeam1Winner: match.team1._id.toString() === winnerId,
    });

    // Update match
    match.winner = winner._id;
    match.loser = loser._id;
    match.team1Score = team1Score || 0;
    match.team2Score = team2Score || 0;
    match.status = isWalkover ? 'walkover' : 'completed';
    match.walkoverReason = isWalkover ? 'Declared by admin' : undefined;
    match.actualEndTime = new Date();

    console.log('Saving match with:', {
      winner: match.winner,
      loser: match.loser,
      team1Score: match.team1Score,
      team2Score: match.team2Score,
    });

    await match.save();

    // Populate the updated match
    const updatedMatch = await Match.findById(matchId).populate(
      'team1 team2 winner loser'
    );

    // Update next match if exists
    if (match.nextMatch && winner) {
      const nextMatch = await Match.findById(match.nextMatch);
      if (nextMatch) {
        if (!nextMatch.team1) {
          nextMatch.team1 = winner._id;
        } else if (!nextMatch.team2) {
          nextMatch.team2 = winner._id;
        }
        nextMatch.status =
          nextMatch.team1 && nextMatch.team2 ? 'scheduled' : 'bye';
        await nextMatch.save();
      }
    }

    // Update standings if group match
    if (match.group) {
      await updateGroupStandings(match);
    }

    console.log(`✅ Winner declared: ${winner.name} won match ${matchId}`);

    res.json({
      success: true,
      message: 'Winner declared successfully',
      match: updatedMatch,
      winner: {
        id: winner._id,
        name: winner.name,
      },
      loser: {
        id: loser._id,
        name: loser.name,
      },
    });
  } catch (error) {
    console.error('❌ Error quick declaring winner:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to declare winner',
      error: error.message,
    });
  }
};

// Generate schedule with courts and times
exports.generateTournamentSchedule = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const {
      startDate,
      endDate,
      startTime,
      endTime,
      courts,
      matchDuration,
      breakDuration,
      scheduleType = 'sequential', // sequential, parallel, round_robin
    } = req.body;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    // Get all unscheduled matches
    const unscheduledMatches = await Match.find({
      tournament: tournamentId,
      $or: [
        { scheduledTime: { $exists: false } },
        { scheduledTime: null },
        { status: 'scheduled' },
      ],
    })
      .populate('team1 team2')
      .sort({ round: 1, matchNumber: 1 });

    if (unscheduledMatches.length === 0) {
      return res.json({
        success: true,
        message: 'All matches are already scheduled',
        matches: [],
      });
    }

    // Parse dates and times
    const startDateTime = new Date(startDate);
    const endDateTime = new Date(endDate);
    const [startHour, startMinute] = startTime.split(':').map(Number);
    const [endHour, endMinute] = endTime.split(':').map(Number);

    const matchDurationMinutes =
      matchDuration || tournament.settings.matchDuration || 40;
    const breakDurationMinutes =
      breakDuration || tournament.settings.breakDuration || 10;
    const totalSlotDuration = matchDurationMinutes + breakDurationMinutes;

    const scheduledMatches = [];
    const courtAssignments = {};
    const dateSlots = {};

    // Initialize court assignments
    courts.forEach((court) => {
      courtAssignments[court] = [];
    });

    let matchIndex = 0;
    let currentDate = new Date(startDateTime);

    // Create time slots for each day
    while (
      currentDate <= endDateTime &&
      matchIndex < unscheduledMatches.length
    ) {
      const dateStr = currentDate.toISOString().split('T')[0];
      dateSlots[dateStr] = [];

      let currentTime = new Date(currentDate);
      currentTime.setHours(startHour, startMinute, 0, 0);

      const dayEnd = new Date(currentDate);
      dayEnd.setHours(endHour, endMinute, 0, 0);

      // Create time slots for the day
      while (currentTime < dayEnd && matchIndex < unscheduledMatches.length) {
        const slotEnd = new Date(currentTime);
        slotEnd.setMinutes(slotEnd.getMinutes() + matchDurationMinutes);

        // Assign to available court
        let assignedCourt = null;
        for (const court of courts) {
          const courtSchedule = courtAssignments[court] || [];
          const isCourtAvailable = !courtSchedule.some((slot) => {
            const slotStart = new Date(slot.start);
            const slotEnd = new Date(slot.end);
            return (
              (currentTime >= slotStart && currentTime < slotEnd) ||
              (slotEnd > currentTime && slotEnd <= slotEnd)
            );
          });

          if (isCourtAvailable) {
            assignedCourt = court;
            break;
          }
        }

        if (assignedCourt) {
          const match = unscheduledMatches[matchIndex];

          // Apply constraints (teams shouldn't play back-to-back)
          const teamConstraints = await checkTeamConstraints(
            match.team1?._id,
            match.team2?._id,
            currentTime,
            courtAssignments
          );

          if (teamConstraints.allowed) {
            match.scheduledTime = new Date(currentTime);
            match.court = assignedCourt;
            match.duration = matchDurationMinutes;
            await match.save();

            // Record court assignment
            courtAssignments[assignedCourt].push({
              start: new Date(currentTime),
              end: slotEnd,
              matchId: match._id,
            });

            scheduledMatches.push({
              matchId: match._id,
              matchNumber: match.matchNumber,
              round: match.round,
              teams: `${match.team1?.name || 'TBD'} vs ${match.team2?.name || 'TBD'}`,
              scheduledTime: match.scheduledTime,
              court: assignedCourt,
              duration: matchDurationMinutes,
            });

            matchIndex++;
          }
        }

        // Move to next time slot
        currentTime.setMinutes(currentTime.getMinutes() + totalSlotDuration);
      }

      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    res.json({
      success: true,
      message: `Scheduled ${scheduledMatches.length} matches`,
      scheduledMatches,
      totalSlots: Object.values(courtAssignments).reduce(
        (sum, slots) => sum + slots.length,
        0
      ),
      remainingMatches: unscheduledMatches.length - matchIndex,
    });
  } catch (error) {
    console.error('Error generating schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate schedule',
      error: error.message,
    });
  }
};

// Helper function for team constraints
const checkTeamConstraints = async (
  team1Id,
  team2Id,
  proposedTime,
  courtAssignments
) => {
  // Check if teams are playing elsewhere at the same time
  // Check for minimum rest periods (e.g., 60 minutes between matches)
  const MIN_REST_MINUTES = 60;

  const conflicts = {
    team1: false,
    team2: false,
    message: '',
  };

  // Check all court assignments for conflicts
  for (const [court, slots] of Object.entries(courtAssignments)) {
    for (const slot of slots) {
      const slotStart = new Date(slot.start);
      const slotEnd = new Date(slot.end);

      // Check if proposed time overlaps with existing slot
      const proposedEnd = new Date(proposedTime);
      proposedEnd.setMinutes(proposedEnd.getMinutes() + MIN_REST_MINUTES);

      const isOverlap =
        (proposedTime >= slotStart && proposedTime < slotEnd) ||
        (proposedEnd > slotStart && proposedEnd <= slotEnd);

      if (isOverlap) {
        // Get match details to check teams
        const match = await Match.findById(slot.matchId).populate(
          'team1 team2'
        );
        if (match) {
          if (
            team1Id &&
            (match.team1?._id?.toString() === team1Id.toString() ||
              match.team2?._id?.toString() === team1Id.toString())
          ) {
            conflicts.team1 = true;
            conflicts.message += `Team 1 has a match at ${slotStart.toLocaleTimeString()}. `;
          }
          if (
            team2Id &&
            (match.team1?._id?.toString() === team2Id.toString() ||
              match.team2?._id?.toString() === team2Id.toString())
          ) {
            conflicts.team2 = true;
            conflicts.message += `Team 2 has a match at ${slotStart.toLocaleTimeString()}. `;
          }
        }
      }
    }
  }

  return {
    allowed: !conflicts.team1 && !conflicts.team2,
    conflicts,
  };
};

// Bulk schedule matches
exports.bulkScheduleMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { scheduleData } = req.body; // Array of { matchId, scheduledTime, court }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const results = {
      succeeded: [],
      failed: [],
    };

    for (const scheduleItem of scheduleData) {
      try {
        const match = await Match.findById(scheduleItem.matchId);
        if (!match) {
          results.failed.push({
            matchId: scheduleItem.matchId,
            reason: 'Match not found',
          });
          continue;
        }

        if (match.tournament.toString() !== tournamentId) {
          results.failed.push({
            matchId: scheduleItem.matchId,
            reason: 'Match does not belong to this tournament',
          });
          continue;
        }

        // Validate time slot
        const scheduledTime = new Date(scheduleItem.scheduledTime);
        if (isNaN(scheduledTime.getTime())) {
          results.failed.push({
            matchId: scheduleItem.matchId,
            reason: 'Invalid date/time',
          });
          continue;
        }

        // Check for conflicts
        const conflicts = await Match.find({
          tournament: tournamentId,
          _id: { $ne: match._id },
          scheduledTime: {
            $gte: new Date(scheduledTime.getTime() - 60 * 60 * 1000), // 1 hour before
            $lte: new Date(scheduledTime.getTime() + 60 * 60 * 1000), // 1 hour after
          },
          $or: [
            { team1: match.team1 },
            { team2: match.team1 },
            { team1: match.team2 },
            { team2: match.team2 },
          ],
        });

        if (conflicts.length > 0) {
          results.failed.push({
            matchId: scheduleItem.matchId,
            reason: 'Team has another match within 1 hour',
          });
          continue;
        }

        // Update match
        match.scheduledTime = scheduledTime;
        match.court = scheduleItem.court || match.court;
        await match.save();

        results.succeeded.push({
          matchId: match._id,
          matchNumber: match.matchNumber,
          scheduledTime: match.scheduledTime,
          court: match.court,
        });
      } catch (error) {
        results.failed.push({
          matchId: scheduleItem.matchId,
          reason: error.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Scheduled ${results.succeeded.length} matches, ${results.failed.length} failed`,
      results,
    });
  } catch (error) {
    console.error('Error bulk scheduling:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to bulk schedule matches',
      error: error.message,
    });
  }
};

// Get schedule for a specific date
exports.getScheduleForDate = async (req, res) => {
  try {
    const { tournamentId, date } = req.params;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const startDate = new Date(date);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(date);
    endDate.setHours(23, 59, 59, 999);

    const matches = await Match.find({
      tournament: tournamentId,
      scheduledTime: {
        $gte: startDate,
        $lte: endDate,
      },
    })
      .populate('team1 team2 referee')
      .sort({ scheduledTime: 1, court: 1 });

    // Group by court
    const scheduleByCourt = {};
    matches.forEach((match) => {
      const court = match.court || 'Unassigned';
      if (!scheduleByCourt[court]) {
        scheduleByCourt[court] = [];
      }
      scheduleByCourt[court].push(match);
    });

    res.json({
      success: true,
      date: date,
      matches,
      scheduleByCourt,
      totalMatches: matches.length,
    });
  } catch (error) {
    console.error('Error fetching schedule for date:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch schedule',
      error: error.message,
    });
  }
};

// Update match schedule
exports.updateMatchSchedule = async (req, res) => {
  try {
    const { matchId } = req.params;
    const { scheduledTime, court, duration, referee } = req.body;

    const match = await Match.findById(matchId).populate('tournament');
    if (!match) {
      return res.status(404).json({
        success: false,
        message: 'Match not found',
      });
    }

    // Validate time if provided
    if (scheduledTime) {
      const newTime = new Date(scheduledTime);
      if (isNaN(newTime.getTime())) {
        return res.status(400).json({
          success: false,
          message: 'Invalid date/time format',
        });
      }

      // Check for scheduling conflicts
      const conflicts = await Match.find({
        tournament: match.tournament._id,
        _id: { $ne: match._id },
        scheduledTime: {
          $gte: new Date(newTime.getTime() - 30 * 60 * 1000), // 30 minutes before
          $lte: new Date(newTime.getTime() + 90 * 60 * 1000), // 90 minutes after (match + buffer)
        },
        $or: [
          { court: court || match.court },
          { team1: match.team1 },
          { team2: match.team1 },
          { team1: match.team2 },
          { team2: match.team2 },
        ],
      });

      if (conflicts.length > 0) {
        const conflictDetails = conflicts.map((c) => ({
          matchNumber: c.matchNumber,
          teams: `${c.team1?.name || 'TBD'} vs ${c.team2?.name || 'TBD'}`,
          time: c.scheduledTime,
          court: c.court,
        }));

        return res.status(409).json({
          success: false,
          message: 'Scheduling conflict detected',
          conflicts: conflictDetails,
        });
      }

      match.scheduledTime = newTime;
      match.isRescheduled = match.scheduledTime !== newTime;
    }

    if (court !== undefined) match.court = court;
    if (duration !== undefined) match.duration = duration;
    if (referee !== undefined) match.referee = referee;

    await match.save();

    const updatedMatch = await Match.findById(matchId).populate(
      'team1 team2 referee'
    );

    res.json({
      success: true,
      message: 'Schedule updated successfully',
      match: updatedMatch,
    });
  } catch (error) {
    console.error('Error updating match schedule:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update schedule',
      error: error.message,
    });
  }
};

// Get available time slots
exports.getAvailableTimeSlots = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    const { date, startTime, endTime, court } = req.query;

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found',
      });
    }

    const targetDate = date ? new Date(date) : new Date();
    targetDate.setHours(0, 0, 0, 0);

    const defaultStartHour = startTime ? parseInt(startTime.split(':')[0]) : 8;
    const defaultStartMinute = startTime
      ? parseInt(startTime.split(':')[1])
      : 0;
    const defaultEndHour = endTime ? parseInt(endTime.split(':')[0]) : 20;
    const defaultEndMinute = endTime ? parseInt(endTime.split(':')[1]) : 0;

    const matchDuration = tournament.settings.matchDuration || 40;
    const breakDuration = tournament.settings.breakDuration || 10;
    const slotDuration = matchDuration + breakDuration;

    // Get all matches for the date
    const startOfDay = new Date(targetDate);
    startOfDay.setHours(defaultStartHour, defaultStartMinute, 0, 0);

    const endOfDay = new Date(targetDate);
    endOfDay.setHours(defaultEndHour, defaultEndMinute, 0, 0);

    const matches = await Match.find({
      tournament: tournamentId,
      scheduledTime: {
        $gte: startOfDay,
        $lte: endOfDay,
      },
      ...(court && { court: court }),
    }).sort({ scheduledTime: 1 });

    // Generate time slots
    const timeSlots = [];
    let currentTime = new Date(startOfDay);

    while (currentTime < endOfDay) {
      const slotEnd = new Date(currentTime);
      slotEnd.setMinutes(slotEnd.getMinutes() + matchDuration);

      // Check if slot is occupied
      const isOccupied = matches.some((match) => {
        const matchStart = new Date(match.scheduledTime);
        const matchEnd = new Date(matchStart);
        matchEnd.setMinutes(
          matchEnd.getMinutes() + (match.duration || matchDuration)
        );

        return (
          (currentTime >= matchStart && currentTime < matchEnd) ||
          (slotEnd > matchStart && slotEnd <= matchEnd)
        );
      });

      if (!isOccupied) {
        timeSlots.push({
          start: new Date(currentTime),
          end: new Date(slotEnd),
          duration: matchDuration,
          available: true,
        });
      }

      currentTime.setMinutes(currentTime.getMinutes() + slotDuration);
    }

    res.json({
      success: true,
      date: targetDate.toISOString().split('T')[0],
      timeSlots,
      totalSlots: timeSlots.length,
      matchDuration,
      breakDuration,
    });
  } catch (error) {
    console.error('Error getting available time slots:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get available time slots',
      error: error.message,
    });
  }
};

exports.getUnscheduledMatches = async (req, res) => {
  try {
    const { tournamentId } = req.params;

    const matches = await Match.find({
      tournament: tournamentId,
      $or: [
        { scheduledTime: { $exists: false } },
        { scheduledTime: null },
        { scheduledTime: { $eq: undefined } },
      ],
    })
      .populate('team1 team2')
      .sort({ round: 1, matchNumber: 1 });

    res.json({
      success: true,
      matches,
      count: matches.length,
    });
  } catch (error) {
    console.error('Error fetching unscheduled matches:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch unscheduled matches',
      error: error.message,
    });
  }
};

module.exports = exports;
