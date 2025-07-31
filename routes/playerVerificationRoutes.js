const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const { authenticate } = require('../utils/auth');

// Verify multiple players belong to a parent
router.post('/verify-batch', authenticate, async (req, res) => {
  try {
    const { playerIds, parentId } = req.body;

    // Enhanced validation
    if (!playerIds || !Array.isArray(playerIds)) {
      return res.status(400).json({
        success: false,
        error: 'playerIds must be an array',
        received: typeof playerIds,
      });
    }

    if (!parentId) {
      return res.status(400).json({
        success: false,
        error: 'parentId is required',
      });
    }

    // Validate each player ID
    const invalidPlayerIds = playerIds.filter(
      (id) => !mongoose.Types.ObjectId.isValid(id)
    );

    if (invalidPlayerIds.length > 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid player IDs found',
        invalidPlayerIds,
      });
    }

    // Check if parent exists
    const parentExists = await Parent.exists({ _id: parentId });
    if (!parentExists) {
      return res.status(404).json({
        success: false,
        error: 'Parent not found',
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
        verifiedPlayers: players.map((p) => p._id.toString()),
      });
    }

    res.json({
      success: true,
      verifiedPlayers: players.map((p) => p._id.toString()),
    });
  } catch (error) {
    console.error('Player verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error during verification',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
