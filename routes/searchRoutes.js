const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Parent = require('../models/Parent');

router.get('/all', async (req, res) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) return res.json([]);

    // Search players and get distinct school names
    const [players, parents, coaches, schoolNames] = await Promise.all([
      Player.find({
        $or: [
          { fullName: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      }).limit(5),

      Parent.find({
        $or: [
          { fullName: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      }).limit(5),

      Parent.find({
        isCoach: true,
        $or: [
          { fullName: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
        ],
      }).limit(5),

      Player.aggregate([
        {
          $match: {
            schoolName: { $regex: searchTerm, $options: 'i' },
          },
        },
        {
          $group: {
            _id: '$schoolName',
            playerCount: { $sum: 1 },
          },
        },
        { $limit: 5 },
      ]),
    ]);

    // Format results
    const results = [
      ...players.map((p) => ({
        id: p._id,
        type: 'player',
        name: p.fullName,
        dob: p.dob ? p.dob.toISOString().split('T')[0] : 'N/A',
        grade: p.grade || 'N/A',
        gender: p.gender || 'N/A',
        aauNumber: p.aauNumber || 'N/A',
        image: p.profileImage || 'assets/img/profiles/avatar-27.jpg',
        additionalInfo: p.schoolName,
        createdAt: p.createdAt,
      })),

      ...parents.map((p) => ({
        id: p._id,
        type: 'parent',
        name: p.fullName,
        email: p.email,
        phone: p.phone,
        address: p.address,
        aauNumber: p.aauNumber,
        image: p.profileImage || 'assets/img/profiles/avatar-27.jpg',
      })),

      ...coaches.map((c) => ({
        id: c._id,
        type: 'coach',
        name: c.fullName,
        email: c.email,
        image: c.profileImage || 'assets/img/profiles/avatar-27.jpg',
      })),

      ...schoolNames.map((s) => ({
        id: s._id,
        type: 'school',
        name: s._id,
        additionalInfo: `${s.playerCount} player${
          s.playerCount !== 1 ? 's' : ''
        }`,
      })),
    ];

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
