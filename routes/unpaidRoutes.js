const express = require('express');
const Registration = require('../models/Registration');
const router = express.Router();

router.get('/unpaid', async (req, res) => {
  try {
    const { parentId } = req.query;

    if (!parentId) {
      return res.status(400).json({
        message: 'Parent ID is required',
      });
    }

    // Find unpaid registrations for this parent
    const unpaidRegistrations = await Registration.find({
      parent: parentId,
      paymentStatus: 'pending',
    })
      .populate('player', 'fullName dob schoolName grade')
      .lean();

    res.json({
      unpaidPlayers: unpaidRegistrations.map((reg) => ({
        _id: reg._id,
        playerId: reg.player._id,
        fullName: reg.player.fullName,
        season: reg.season,
        registrationYear: reg.year,
        amountDue: reg.amountDue,
      })),
    });
  } catch (error) {
    console.error('Error in unpaid endpoint:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
    });
  }
});

module.exports = router;
