const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Player = require('../models/Player');
const { authenticate } = require('../utils/auth');

// Verify multiple players belong to a parent
router.post('/verify-batch', authenticate, async (req, res) => {
  try {
    const { playerIds, parentId } = req.body;

    // Validate input
    if (!playerIds || !Array.isArray(playerIds)) {
      return res.status(400).json({
        success: false,
        error: 'playerIds must be an array of strings',
        received: playerIds,
      });
    }

    if (!parentId || !mongoose.Types.ObjectId.isValid(parentId)) {
      return res.status(400).json({
        success: false,
        error: 'Valid parentId is required',
      });
    }

    // Verify each player belongs to the parent
    const players = await Player.find({
      _id: { $in: playerIds },
      parentId: parentId,
    });

    // Check if all players were found
    const foundPlayerIds = players.map((p) => p._id.toString());
    const missingPlayers = playerIds.filter(
      (id) => !foundPlayerIds.includes(id)
    );

    if (missingPlayers.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Some players not found or belong to different parent',
        missingPlayers,
        verifiedPlayers: foundPlayerIds,
      });
    }

    res.json({
      success: true,
      verifiedPlayers: foundPlayerIds,
    });
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during verification',
    });
  }
});

module.exports = router;
