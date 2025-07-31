const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const { authenticate } = require('../utils/auth');

// Verify multiple players belong to a parent
router.post('/verify-batch', authenticate, async (req, res) => {
  try {
    const { playerIds, parentId } = req.body;

    if (!playerIds || !Array.isArray(playerIds) || !parentId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request data',
      });
    }

    const players = await Player.find({
      _id: { $in: playerIds },
      parentId: parentId,
    });

    if (players.length !== playerIds.length) {
      const missingPlayers = playerIds.filter(
        (id) => !players.some((p) => p._id.toString() === id)
      );

      return res.status(400).json({
        success: false,
        error: "Some players not found or don't belong to parent",
        missingPlayers,
      });
    }

    res.json({ success: true, verifiedPlayers: players.map((p) => p._id) });
  } catch (error) {
    console.error('Player verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during verification',
    });
  }
});

module.exports = router;
