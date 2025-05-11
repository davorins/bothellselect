const express = require('express');
const router = express.Router();
const Player = require('../models/Player');
const Parent = require('../models/Parent');
const Payment = require('../models/Payment');
const { authenticate, isAdmin } = require('../utils/auth');
const mongoose = require('mongoose');

// Default avatar URLs
const DEFAULT_PARENT_AVATAR =
  'https://bothell-select.onrender.com/uploads/avatars/parents.png';
const DEFAULT_COACH_AVATAR =
  'https://bothell-select.onrender.com/uploads/avatars/coach.png';
const DEFAULT_GIRL_AVATAR =
  'https://bothell-select.onrender.com/uploads/avatars/girl.png';
const DEFAULT_BOY_AVATAR =
  'https://bothell-select.onrender.com/uploads/avatars/boy.png';

// Helper function to get player avatar URL
const getPlayerAvatar = (player) => {
  if (!player) return DEFAULT_BOY_AVATAR;

  if (player.avatar) {
    if (player.avatar.includes('res.cloudinary.com')) {
      return player.avatar;
    }
    if (player.avatar.startsWith('/uploads/avatars/')) {
      return `https://bothell-select.onrender.com${player.avatar}`;
    }
    return player.avatar;
  }

  return player.gender?.toLowerCase() === 'female'
    ? DEFAULT_GIRL_AVATAR
    : DEFAULT_BOY_AVATAR;
};

// Helper to safely populate player references
const safePopulatePlayer = async (payment) => {
  try {
    if (payment.playerId && mongoose.isValidObjectId(payment.playerId)) {
      payment.playerId = await Player.findById(payment.playerId)
        .select('fullName gender avatar schoolName')
        .lean();
    }

    if (payment.playerIds && Array.isArray(payment.playerIds)) {
      payment.playerIds = await Player.find({
        _id: {
          $in: payment.playerIds.filter((id) => mongoose.isValidObjectId(id)),
        },
      })
        .select('fullName gender avatar schoolName')
        .lean();
    }

    return payment;
  } catch (error) {
    console.error('Error populating player data:', error);
    return payment;
  }
};

// Main search endpoint
router.get('/all', authenticate, async (req, res) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) return res.json([]);

    // Check if search term is exactly 4 digits (potential card search)
    const isCardSearch = /^\d{4}$/.test(searchTerm);
    const isAdminUser = req.user?.role === 'admin';

    // Clean phone number search by removing non-digits
    const phoneSearchTerm = searchTerm.replace(/\D/g, '');

    // Base searches (players, parents with guardians, coaches, schools)
    const baseSearches = [
      Player.find({
        $or: [
          { fullName: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
          phoneSearchTerm.length >= 3
            ? { phone: { $regex: phoneSearchTerm, $options: 'i' } }
            : {},
        ].filter((cond) => Object.keys(cond).length > 0),
      }).limit(5),

      Parent.find({
        $or: [
          { fullName: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
          phoneSearchTerm.length >= 3
            ? { phone: { $regex: phoneSearchTerm, $options: 'i' } }
            : {},
          {
            'additionalGuardians.fullName': {
              $regex: searchTerm,
              $options: 'i',
            },
          },
          {
            'additionalGuardians.email': { $regex: searchTerm, $options: 'i' },
          },
          phoneSearchTerm.length >= 3
            ? {
                'additionalGuardians.phone': {
                  $regex: phoneSearchTerm,
                  $options: 'i',
                },
              }
            : {},
        ].filter((cond) => Object.keys(cond).length > 0),
      }).limit(10),

      Parent.find({
        isCoach: true,
        $or: [
          { fullName: { $regex: searchTerm, $options: 'i' } },
          { email: { $regex: searchTerm, $options: 'i' } },
          phoneSearchTerm.length >= 3
            ? { phone: { $regex: phoneSearchTerm, $options: 'i' } }
            : {},
          {
            'additionalGuardians.fullName': {
              $regex: searchTerm,
              $options: 'i',
            },
          },
          {
            'additionalGuardians.email': { $regex: searchTerm, $options: 'i' },
          },
          phoneSearchTerm.length >= 3
            ? {
                'additionalGuardians.phone': {
                  $regex: phoneSearchTerm,
                  $options: 'i',
                },
              }
            : {},
        ].filter((cond) => Object.keys(cond).length > 0),
      }).limit(10),

      Player.aggregate([
        { $match: { schoolName: { $regex: searchTerm, $options: 'i' } } },
        { $group: { _id: '$schoolName', playerCount: { $sum: 1 } } },
        { $limit: 5 },
      ]),
    ];

    // Payment search for admins - with safe population
    const paymentSearch =
      isCardSearch && isAdminUser
        ? (async () => {
            const payments = await Payment.find({ cardLastFour: searchTerm })
              .populate({
                path: 'parentId',
                model: 'Parent',
                select:
                  'fullName email phone avatar isCoach additionalGuardians',
              })
              .limit(10)
              .lean();

            // Safely populate player data
            return Promise.all(
              payments.map(async (payment) => {
                await safePopulatePlayer(payment);
                return payment;
              })
            );
          })()
        : Promise.resolve([]);

    const [players, parents, coaches, schoolNames, paymentMatches] =
      await Promise.all([...baseSearches, paymentSearch]);

    // Format results
    const formatPlayer = (player) => ({
      id: player._id,
      type: 'player',
      name: player.fullName,
      dob: player.dob ? player.dob.toISOString().split('T')[0] : 'N/A',
      grade: player.grade || 'N/A',
      gender: player.gender || 'N/A',
      aauNumber: player.aauNumber || 'N/A',
      status: player.status || '',
      season: player.season || '',
      registrationYear: player.registrationYear || null,
      image: getPlayerAvatar(player),
      additionalInfo: player.schoolName || '',
      createdAt: player.createdAt,
      phone: player.phone,
      isActive: player.status === 'active',
    });

    const formatParent = (parent) => {
      const results = [];

      // Check if primary parent matches search
      if (
        parent.fullName.match(new RegExp(searchTerm, 'i')) ||
        parent.email.match(new RegExp(searchTerm, 'i')) ||
        (phoneSearchTerm.length >= 3 && parent.phone?.includes(phoneSearchTerm))
      ) {
        results.push({
          id: parent._id,
          type: parent.isCoach ? 'coach' : 'parent',
          name: parent.fullName,
          email: parent.email,
          phone: parent.phone,
          address: parent.address,
          aauNumber: parent.aauNumber,
          image:
            parent.avatar ||
            (parent.isCoach ? DEFAULT_COACH_AVATAR : DEFAULT_PARENT_AVATAR),
          isPrimary: true,
        });
      }

      // Check additional guardians
      parent.additionalGuardians?.forEach((guardian) => {
        if (
          guardian.fullName.match(new RegExp(searchTerm, 'i')) ||
          guardian.email.match(new RegExp(searchTerm, 'i')) ||
          (phoneSearchTerm.length >= 3 &&
            guardian.phone?.includes(phoneSearchTerm))
        ) {
          results.push({
            id: guardian._id || new mongoose.Types.ObjectId(),
            parentId: parent._id,
            parentName: parent.fullName,
            type: 'guardian',
            name: guardian.fullName,
            email: guardian.email,
            phone: guardian.phone,
            image: guardian.avatar || DEFAULT_PARENT_AVATAR,
            isPrimary: false,
            relationship: guardian.relationship,
            isCoach: guardian.isCoach || false,
            aauNumber: guardian.isCoach ? guardian.aauNumber : undefined,
          });
        }
      });

      return results;
    };

    const formatSchool = (school) => ({
      id: school._id,
      type: 'school',
      name: school._id,
      additionalInfo: `${school.playerCount} player${school.playerCount !== 1 ? 's' : ''}`,
    });

    const formatPaymentMatches = (payment) => {
      const results = [];

      if (payment.parentId) {
        results.push({
          id: payment.parentId._id,
          type: payment.parentId.isCoach ? 'coach' : 'parent',
          name: payment.parentId.fullName,
          email: payment.parentId.email,
          phone: payment.parentId.phone,
          image:
            payment.parentId.avatar ||
            (payment.parentId.isCoach
              ? DEFAULT_COACH_AVATAR
              : DEFAULT_PARENT_AVATAR),
          isPaymentMatch: true,
          paymentDetails: {
            cardBrand: payment.cardBrand,
            cardLastFour: payment.cardLastFour,
            amount: payment.amount,
            date: payment.createdAt,
            receiptUrl: payment.receiptUrl,
          },
        });

        // Include matching guardians from payment
        payment.parentId.additionalGuardians?.forEach((guardian) => {
          results.push({
            id: guardian._id,
            parentId: payment.parentId._id,
            type: 'guardian',
            name: guardian.fullName,
            email: guardian.email,
            phone: guardian.phone,
            image: guardian.avatar || DEFAULT_PARENT_AVATAR,
            isPaymentMatch: true,
            paymentDetails: {
              cardBrand: payment.cardBrand,
              cardLastFour: payment.cardLastFour,
              amount: payment.amount,
              date: payment.createdAt,
            },
          });
        });
      }

      if (payment.playerId && payment.playerId._id) {
        results.push({
          id: payment.playerId._id,
          type: 'player',
          name: payment.playerId.fullName,
          image: getPlayerAvatar(payment.playerId),
          additionalInfo: `Card: ${payment.cardBrand} ••••${payment.cardLastFour}`,
          isPaymentMatch: true,
        });
      }

      if (payment.playerIds?.length) {
        payment.playerIds.forEach((player) => {
          if (player._id) {
            results.push({
              id: player._id,
              type: 'player',
              name: player.fullName,
              image: getPlayerAvatar(player),
              additionalInfo: `Card: ${payment.cardBrand} ••••${payment.cardLastFour}`,
              isPaymentMatch: true,
            });
          }
        });
      }

      return results;
    };

    // Combine all results
    const allResults = [
      ...paymentMatches.flatMap(formatPaymentMatches),
      ...parents.flatMap(formatParent),
      ...coaches.flatMap(formatParent),
      ...players.map(formatPlayer),
      ...schoolNames.map(formatSchool),
    ];

    res.json(allResults);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Search failed',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

module.exports = router;
