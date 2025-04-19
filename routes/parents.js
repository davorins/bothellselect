const express = require('express');
const router = express.Router();
const Parent = require('../models/Parent');
const Player = require('../models/Player');

// Helper function to get current season
function getCurrentSeason() {
  const month = new Date().getMonth() + 1;
  if (month >= 3 && month <= 5) return 'Spring';
  if (month >= 6 && month <= 8) return 'Summer';
  if (month >= 9 && month <= 11) return 'Fall';
  return 'Winter';
}

// Enhanced registration status endpoint
router.get('/:id/registration-status', async (req, res) => {
  try {
    const parent = await Parent.findById(req.params.id);
    if (!parent) {
      return res.status(404).json({ message: 'Parent not found' });
    }

    const players = await Player.find({ parentId: req.params.id });
    const currentSeason = getCurrentSeason();
    const currentYear = new Date().getFullYear();

    // Filter players for current season and year
    const currentSeasonPlayers = players.filter(
      (p) => p.season === currentSeason && p.registrationYear === currentYear
    );

    // Calculate statuses
    const parentRegistered = parent.registrationComplete || false;
    const parentPaid = parent.paymentComplete || false;

    const allPlayersRegistered =
      currentSeasonPlayers.length > 0 &&
      currentSeasonPlayers.every((p) => p.registrationComplete);
    const allPlayersPaid =
      currentSeasonPlayers.length > 0 &&
      currentSeasonPlayers.every((p) => p.paymentComplete);

    res.json({
      // Parent status
      parentRegistered,
      parentPaid,

      // Players summary
      currentSeason,
      currentYear,
      totalPlayers: players.length,
      currentSeasonPlayers: currentSeasonPlayers.length,

      // Players registration status
      hasPlayers: players.length > 0,
      hasCurrentSeasonPlayers: currentSeasonPlayers.length > 0,
      allPlayersRegistered,
      allPlayersPaid,

      // Detailed player info
      players: players.map((player) => ({
        id: player._id,
        name: player.fullName,
        season: player.season,
        year: player.registrationYear,
        registered: player.registrationComplete || false,
        paid: player.paymentComplete || false,
        isCurrentSeason:
          player.season === currentSeason &&
          player.registrationYear === currentYear,
      })),

      // Overall status
      fullyRegistered: parentRegistered && allPlayersRegistered,
      fullyPaid: parentPaid && allPlayersPaid,
      readyForSeason:
        parentRegistered &&
        parentPaid &&
        allPlayersRegistered &&
        allPlayersPaid,
    });
  } catch (error) {
    console.error('Error fetching registration status:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
    });
  }
});

// Endpoint to mark parent registration as complete
router.post('/:id/mark-registration-complete', async (req, res) => {
  try {
    const parent = await Parent.findByIdAndUpdate(
      req.params.id,
      { registrationComplete: true },
      { new: true }
    );

    if (!parent) {
      return res.status(404).json({ message: 'Parent not found' });
    }

    res.json({
      success: true,
      parentId: parent._id,
      registrationComplete: parent.registrationComplete,
    });
  } catch (error) {
    console.error('Error marking registration complete:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
    });
  }
});

// Endpoint to mark parent payment as complete
router.post('/:id/mark-payment-complete', async (req, res) => {
  try {
    const parent = await Parent.findByIdAndUpdate(
      req.params.id,
      { paymentComplete: true },
      { new: true }
    );

    if (!parent) {
      return res.status(404).json({ message: 'Parent not found' });
    }

    res.json({
      success: true,
      parentId: parent._id,
      paymentComplete: parent.paymentComplete,
    });
  } catch (error) {
    console.error('Error marking payment complete:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
    });
  }
});

module.exports = router;
