// utils/tournamentUtils.js - FIXED version
const Team = require('../models/Team');

exports.extractTournamentsFromTeams = async () => {
  try {
    console.log('🔍 Extracting tournaments from teams collection...');

    // Get all active teams with tournament data
    const teams = await Team.find({
      isActive: true,
      $or: [
        { tournament: { $exists: true, $ne: '' } },
        { tournaments: { $exists: true, $ne: [] } },
      ],
    })
      .select(
        'name grade sex levelOfCompetition tournament tournaments registrationYear'
      )
      .lean();

    console.log(`📊 Found ${teams.length} active teams with tournament data`);

    const tournamentMap = new Map();

    teams.forEach((team) => {
      // Check main tournament field
      if (team.tournament && team.tournament.trim() !== '') {
        const key = `${team.tournament}|${team.registrationYear || new Date().getFullYear()}`;
        if (!tournamentMap.has(key)) {
          tournamentMap.set(key, {
            name: team.tournament,
            year: team.registrationYear || new Date().getFullYear(),
            teams: [],
            levelOfCompetition: 'All',
            sex: 'Mixed',
            levelCount: { Gold: 0, Silver: 0 }, // Track level counts
            sexCount: { Male: 0, Female: 0 },
          });
        }

        const tournament = tournamentMap.get(key);
        tournament.teams.push({
          _id: team._id,
          name: team.name,
          grade: team.grade,
          sex: team.sex,
          levelOfCompetition: team.levelOfCompetition,
          tournament: team.tournament,
          registrationYear: team.registrationYear || new Date().getFullYear(),
        });

        // Track level counts
        if (team.levelOfCompetition === 'Gold') {
          tournament.levelCount.Gold++;
        } else if (team.levelOfCompetition === 'Silver') {
          tournament.levelCount.Silver++;
        }

        // Track sex counts
        if (team.sex === 'Male') {
          tournament.sexCount.Male++;
        } else if (team.sex === 'Female') {
          tournament.sexCount.Female++;
        }

        // Determine tournament level based on counts
        if (
          tournament.levelCount.Gold > 0 &&
          tournament.levelCount.Silver === 0
        ) {
          tournament.levelOfCompetition = 'Gold';
        } else if (
          tournament.levelCount.Silver > 0 &&
          tournament.levelCount.Gold === 0
        ) {
          tournament.levelOfCompetition = 'Silver';
        } else if (
          tournament.levelCount.Gold > 0 &&
          tournament.levelCount.Silver > 0
        ) {
          tournament.levelOfCompetition = 'All'; // Changed from 'Gold' to 'All'
        }

        // Determine tournament sex based on counts
        if (tournament.sexCount.Male > 0 && tournament.sexCount.Female === 0) {
          tournament.sex = 'Male';
        } else if (
          tournament.sexCount.Female > 0 &&
          tournament.sexCount.Male === 0
        ) {
          tournament.sex = 'Female';
        } else if (
          tournament.sexCount.Male > 0 &&
          tournament.sexCount.Female > 0
        ) {
          tournament.sex = 'Mixed';
        }
      }

      // Check tournaments array
      if (team.tournaments && Array.isArray(team.tournaments)) {
        team.tournaments.forEach((tournamentReg) => {
          if (
            tournamentReg.tournament &&
            tournamentReg.tournament.trim() !== ''
          ) {
            const key = `${tournamentReg.tournament}|${tournamentReg.year || team.registrationYear || new Date().getFullYear()}`;
            if (!tournamentMap.has(key)) {
              tournamentMap.set(key, {
                name: tournamentReg.tournament,
                year:
                  tournamentReg.year ||
                  team.registrationYear ||
                  new Date().getFullYear(),
                teams: [],
                levelOfCompetition: 'All', // Start with 'All' instead of tournamentReg.levelOfCompetition
                sex: 'Mixed',
                levelCount: { Gold: 0, Silver: 0 },
                sexCount: { Male: 0, Female: 0 },
              });
            }

            const tournament = tournamentMap.get(key);
            tournament.teams.push({
              _id: team._id,
              name: team.name,
              grade: team.grade,
              sex: team.sex,
              levelOfCompetition: team.levelOfCompetition,
              tournament: tournamentReg.tournament,
              registrationYear:
                tournamentReg.year ||
                team.registrationYear ||
                new Date().getFullYear(),
              paymentComplete: tournamentReg.paymentComplete,
              paymentStatus: tournamentReg.paymentStatus,
            });

            // Track level counts
            if (team.levelOfCompetition === 'Gold') {
              tournament.levelCount.Gold++;
            } else if (team.levelOfCompetition === 'Silver') {
              tournament.levelCount.Silver++;
            }

            // Track sex counts
            if (team.sex === 'Male') {
              tournament.sexCount.Male++;
            } else if (team.sex === 'Female') {
              tournament.sexCount.Female++;
            }

            // Determine tournament level based on counts
            if (
              tournament.levelCount.Gold > 0 &&
              tournament.levelCount.Silver === 0
            ) {
              tournament.levelOfCompetition = 'Gold';
            } else if (
              tournament.levelCount.Silver > 0 &&
              tournament.levelCount.Gold === 0
            ) {
              tournament.levelOfCompetition = 'Silver';
            } else if (
              tournament.levelCount.Gold > 0 &&
              tournament.levelCount.Silver > 0
            ) {
              tournament.levelOfCompetition = 'All'; // Changed from 'Gold' to 'All'
            }

            // Determine tournament sex based on counts
            if (
              tournament.sexCount.Male > 0 &&
              tournament.sexCount.Female === 0
            ) {
              tournament.sex = 'Male';
            } else if (
              tournament.sexCount.Female > 0 &&
              tournament.sexCount.Male === 0
            ) {
              tournament.sex = 'Female';
            } else if (
              tournament.sexCount.Male > 0 &&
              tournament.sexCount.Female > 0
            ) {
              tournament.sex = 'Mixed';
            }
          }
        });
      }
    });

    // Convert map to array, remove duplicates, and sort
    const tournaments = Array.from(tournamentMap.values())
      .map((tournament) => {
        // Remove duplicate teams
        const uniqueTeams = [];
        const teamIds = new Set();

        tournament.teams.forEach((team) => {
          if (!teamIds.has(team._id.toString())) {
            teamIds.add(team._id.toString());
            uniqueTeams.push(team);
          }
        });

        // Remove internal tracking fields from final output
        const { levelCount, sexCount, ...tournamentData } = tournament;

        return {
          ...tournamentData,
          teams: uniqueTeams,
          teamCount: uniqueTeams.length,
        };
      })
      .filter((tournament) => tournament.teamCount > 0)
      .sort((a, b) => {
        if (b.year !== a.year) return b.year - a.year;
        return a.name.localeCompare(b.name);
      });

    console.log(
      `✅ Extracted ${tournaments.length} unique tournaments from teams`
    );

    return tournaments;
  } catch (error) {
    console.error('❌ Error extracting tournaments from teams:', error);
    throw error;
  }
};

/**
 * Get teams for a specific tournament name and year
 */
exports.getTeamsForTournament = async (tournamentName, year) => {
  try {
    console.log(`🔍 Fetching teams for tournament: ${tournamentName} ${year}`);

    // Find teams where either:
    // 1. main tournament field matches
    // 2. tournaments array contains the tournament
    const teams = await Team.find({
      isActive: true,
      $or: [
        {
          tournament: tournamentName,
          registrationYear: parseInt(year),
        },
        {
          'tournaments.tournament': tournamentName,
          'tournaments.year': parseInt(year),
        },
      ],
    })
      .select(
        'name grade sex levelOfCompetition tournament tournaments registrationYear coachIds paymentComplete paymentStatus isActive'
      )
      .populate('coachIds', 'firstName lastName email')
      .lean();

    console.log(`✅ Found ${teams.length} teams for ${tournamentName} ${year}`);

    // Transform teams to match expected format
    return teams.map((team) => {
      // Find the specific tournament registration
      const tournamentReg =
        team.tournaments?.find(
          (t) => t.tournament === tournamentName && t.year === parseInt(year)
        ) || {};

      return {
        _id: team._id,
        name: team.name,
        grade: team.grade,
        sex: team.sex,
        levelOfCompetition: team.levelOfCompetition,
        tournament: team.tournament,
        registrationYear: team.registrationYear,
        tournaments: team.tournaments || [],
        coachIds: team.coachIds || [],
        isActive: team.isActive,
        paymentComplete:
          tournamentReg.paymentComplete || team.paymentComplete || false,
        paymentStatus:
          tournamentReg.paymentStatus || team.paymentStatus || 'pending',
        registrationDate: tournamentReg.registrationDate || new Date(),
      };
    });
  } catch (error) {
    console.error('❌ Error getting teams for tournament:', error);
    throw error;
  }
};

/**
 * Create or update a tournament document based on teams
 */
exports.createOrUpdateTournamentFromTeams = async (
  tournamentName,
  year,
  userId
) => {
  try {
    const Tournament = require('../models/Tournament');

    console.log(`🔄 Creating/updating tournament: ${tournamentName} ${year}`);

    // Get teams for this tournament
    const teams = await exports.getTeamsForTournament(tournamentName, year);

    if (teams.length === 0) {
      throw new Error(
        `No active teams found for tournament: ${tournamentName} ${year}`
      );
    }

    // Calculate level breakdown
    const goldCount = teams.filter(
      (t) => t.levelOfCompetition === 'Gold'
    ).length;
    const silverCount = teams.filter(
      (t) => t.levelOfCompetition === 'Silver'
    ).length;

    console.log(
      `📊 Level breakdown for ${tournamentName}: Gold=${goldCount}, Silver=${silverCount}`
    );

    // Determine level of competition based on counts
    let levelOfCompetition;
    if (goldCount > 0 && silverCount === 0) {
      levelOfCompetition = 'Gold';
    } else if (silverCount > 0 && goldCount === 0) {
      levelOfCompetition = 'Silver';
    } else if (goldCount > 0 && silverCount > 0) {
      levelOfCompetition = 'All'; // Changed from 'Gold' to 'All'
    } else {
      levelOfCompetition = 'All';
    }

    // Calculate gender breakdown
    const maleCount = teams.filter((t) => t.sex === 'Male').length;
    const femaleCount = teams.filter((t) => t.sex === 'Female').length;

    console.log(
      `📊 Gender breakdown for ${tournamentName}: Male=${maleCount}, Female=${femaleCount}`
    );

    // Determine sex based on counts
    let sex;
    if (maleCount > 0 && femaleCount === 0) {
      sex = 'Male';
    } else if (femaleCount > 0 && maleCount === 0) {
      sex = 'Female';
    } else if (maleCount > 0 && femaleCount > 0) {
      sex = 'Mixed';
    } else {
      sex = 'Mixed';
    }

    console.log(
      `🎯 Determined tournament level: ${levelOfCompetition}, sex: ${sex}`
    );

    // Find existing tournament
    let tournament = await Tournament.findOne({
      name: tournamentName,
      year: parseInt(year),
    });

    // Calculate appropriate bracket size
    const teamCount = teams.length;
    const nextPowerOfTwo = Math.pow(2, Math.ceil(Math.log2(teamCount)));
    const maxTeams = Math.max(nextPowerOfTwo, 16);
    const minTeams = Math.min(4, teamCount);

    const tournamentData = {
      name: tournamentName,
      year: parseInt(year),
      description: `${tournamentName} ${year}`,
      startDate: new Date(),
      endDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
      status: 'draft',
      levelOfCompetition,
      sex,
      format: 'single-elimination',
      maxTeams,
      minTeams,
      registeredTeams: teams.map((t) => t._id),
      settings: {
        pointsPerWin: 3,
        pointsPerDraw: 1,
        pointsPerLoss: 0,
        matchDuration: 40,
        breakDuration: 10,
      },
      createdBy: userId,
      isActive: true,
    };

    if (tournament) {
      // Update existing tournament
      Object.assign(tournament, tournamentData);
      tournament.updatedBy = userId;
      console.log(`🔄 Updating existing tournament: ${tournamentName} ${year}`);
    } else {
      // Create new tournament
      tournament = new Tournament(tournamentData);
      console.log(`✅ Creating new tournament: ${tournamentName} ${year}`);
    }

    await tournament.save();

    // Populate tournament with team details
    const populatedTournament = await Tournament.findById(tournament._id)
      .populate(
        'registeredTeams',
        'name grade sex levelOfCompetition tournament tournaments'
      )
      .lean();

    console.log(
      `✅ Tournament ${tournamentName} ${year} saved with ${teams.length} teams`
    );
    console.log(
      `✅ Tournament level: ${levelOfCompetition} (${goldCount} gold, ${silverCount} silver teams)`
    );
    console.log(
      `✅ Tournament sex: ${sex} (${maleCount} male, ${femaleCount} female teams)`
    );

    return {
      tournament: populatedTournament,
      teams,
      teamCount: teams.length,
    };
  } catch (error) {
    console.error('❌ Error creating/updating tournament from teams:', error);
    throw error;
  }
};
