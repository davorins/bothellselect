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

    const getPlayerAvatar = (player) => {
      // If player has a custom avatar (Cloudinary or local)
      if (player.avatar) {
        // Cloudinary URL
        if (player.avatar.includes('res.cloudinary.com')) {
          return player.avatar;
        }
        // Local URL - ensure it's the full URL
        if (player.avatar.startsWith('/uploads/avatars/')) {
          return `https://bothell-select.onrender.com${player.avatar}`;
        }
        // If it's already a full URL but missing protocol
        if (player.avatar.startsWith('//')) {
          return `https:${player.avatar}`;
        }
        // If it's a relative path without leading slash
        if (player.avatar.startsWith('uploads/avatars/')) {
          return `https://bothell-select.onrender.com/${player.avatar}`;
        }
        return player.avatar; // Fallback for absolute URLs
      }
      // Default avatar based on gender
      return player.gender?.toLowerCase() === 'female'
        ? 'https://bothell-select.onrender.com/uploads/avatars/girl.png'
        : 'https://bothell-select.onrender.com/uploads/avatars/boy.png';
    };

    // Format results
    const results = [
      ...players.map((p) => {
        // Debug log to verify status is present in the raw data
        console.log(`Player ${p._id} raw status:`, p.status);

        return {
          id: p._id,
          type: 'player',
          name: p.fullName,
          dob: p.dob ? p.dob.toISOString().split('T')[0] : 'N/A',
          grade: p.grade || 'N/A',
          gender: p.gender || 'N/A',
          aauNumber: p.aauNumber || 'N/A',
          status: p.status || '',
          season: p.season || '',
          registrationYear: p.registrationYear || null,
          image: getPlayerAvatar(p),
          additionalInfo: p.schoolName || '',
          createdAt: p.createdAt,
          isActive: p.status === 'active',
          playerStatus: p.status,
        };
      }),

      ...parents.map((p) => ({
        id: p._id,
        type: 'parent',
        name: p.fullName,
        email: p.email,
        phone: p.phone,
        address: p.address,
        aauNumber: p.aauNumber,
        image:
          p.profileImage ||
          'https://bothell-select.onrender.com/uploads/avatars/parents.png',
      })),

      ...coaches.map((c) => ({
        id: c._id,
        type: 'coach',
        name: c.fullName,
        email: c.email,
        image:
          c.profileImage ||
          'https://bothell-select.onrender.com/uploads/avatars/coach.png',
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
