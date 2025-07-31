const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult, query } = require('express-validator');
const mongoose = require('mongoose');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Payment = require('../models/Payment');
const Notification = require('../models/Notification');
const {
  comparePasswords,
  hashPassword,
  generateToken,
  authenticate,
} = require('../utils/auth');
const {
  sendEmail,
  sendWelcomeEmail,
  sendResetEmail,
  sendTryoutEmail,
} = require('../utils/email');

const registrationSchema = new mongoose.Schema(
  {
    player: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Player',
      required: [true, 'Player reference is required'],
      index: true,
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Parent',
      required: [true, 'Parent reference is required'],
      index: true,
    },
    season: {
      type: String,
      required: [true, 'Season is required'],
    },
    year: {
      type: Number,
      required: [true, 'Year is required'],
      min: [2020, 'Year must be 2020 or later'],
      max: [2030, 'Year must be 2030 or earlier'],
    },
    tryoutId: { type: String, required: true }, // Remove default: null, make required
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentComplete: { type: Boolean, default: false },
    paymentDate: { type: Date },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

registrationSchema.index(
  { player: 1, season: 1, year: 1, tryoutId: 1 },
  { unique: true }
);
const Registration = mongoose.model('Registration', registrationSchema);

const router = express.Router();

// Generate random password for admin-created accounts
const generateRandomPassword = () => {
  return (
    Math.random().toString(36).slice(-10) +
    Math.random().toString(36).slice(-10)
  );
};

// Generate unique tryoutId based on season and year
const generateTryoutId = (season, year) => {
  const randomString = crypto.randomBytes(4).toString('hex');
  return `${season.toLowerCase().replace(/\s+/g, '-')}-${year}-tryout-${randomString}`;
};

module.exports = {
  hashPassword,
  comparePasswords,
  generateRandomPassword,
};

const addressUtils = {
  parseAddress: (addressInput) => {
    if (typeof addressInput !== 'string') {
      return {
        street: (addressInput.street || '').trim(),
        street2: (addressInput.street2 || '').trim(),
        city: (addressInput.city || '').trim(),
        state: (addressInput.state || '').trim(),
        zip: (addressInput.zip || '').toString().replace(/\D/g, ''),
      };
    }
    if (!addressInput.trim()) {
      return {
        street: '',
        street2: '',
        city: '',
        state: '',
        zip: '',
      };
    }
    const parts = addressInput.split(',').map((part) => part.trim());
    const result = {
      street: parts[0] || '',
      street2: '',
      city: '',
      state: '',
      zip: '',
    };
    if (parts.length > 3) {
      result.street2 = parts.slice(1, -2).join(', ');
    }
    if (parts.length >= 3) {
      result.city = parts[parts.length - 2] || '';
      const stateZip = parts[parts.length - 1].trim().split(/\s+/);
      result.state = stateZip[0] || '';
      result.zip = stateZip[1] || '';
    }
    return result;
  },
  ensureAddress: (address) => {
    if (!address) {
      return {
        street: '',
        street2: '',
        city: '',
        state: '',
        zip: '',
      };
    }
    if (typeof address === 'string') {
      return addressUtils.parseAddress(address);
    }
    return {
      street: (address.street || '').trim(),
      street2: ('street2' in address ? address.street2 : '').trim(),
      city: (address.city || '').trim(),
      state: (address.state || '').trim(),
      zip: (address.zip || '').toString().replace(/\D/g, ''),
    };
  },
};

const { parseAddress, ensureAddress } = addressUtils;

// Register a new parent
router.post(
  '/register',
  [
    body('email').isEmail().withMessage('Invalid email'),
    body('password')
      .if((value, { req }) => req.body.registerType !== 'adminCreate')
      .notEmpty()
      .withMessage('Password is required')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters')
      .custom((value) => value.trim() === value)
      .withMessage('Password cannot start/end with spaces'),
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
    body('address').customSanitizer((value) => {
      if (typeof value === 'string') return parseAddress(value);
      return value;
    }),
    body('address.street').notEmpty().withMessage('Street address is required'),
    body('address.city').notEmpty().withMessage('City is required'),
    body('address.state')
      .isLength({ min: 2, max: 2 })
      .withMessage('State must be 2 letters'),
    body('address.zip').isPostalCode('US').withMessage('Invalid ZIP code'),
    body('relationship').notEmpty().withMessage('Relationship is required'),
    body('isCoach').isBoolean().withMessage('isCoach must be boolean'),
    body('registerType').optional().isIn(['self', 'adminCreate']),
    body('agreeToTerms')
      .if((value, { req }) => req.body.registerType === 'self')
      .isBoolean()
      .withMessage('You must agree to the terms')
      .equals('true')
      .withMessage('You must agree to the terms'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const {
        email,
        password,
        fullName,
        phone,
        address,
        relationship,
        isCoach,
        aauNumber,
        registerType = 'self',
        additionalGuardians = [],
        agreeToTerms,
      } = req.body;

      const normalizedEmail = email.toLowerCase().trim();
      const existingParent = await Parent.findOne({ email: normalizedEmail });

      if (existingParent) {
        return res.status(400).json({ error: 'Email already registered' });
      }

      let tempPassword;
      const plainPassword =
        registerType === 'adminCreate'
          ? (tempPassword = generateRandomPassword()).trim()
          : password.trim();

      if (isCoach && (!aauNumber || aauNumber.trim() === '')) {
        return res
          .status(400)
          .json({ error: 'AAU number required for coaches' });
      }

      const parentData = {
        email: normalizedEmail,
        password: plainPassword,
        fullName: fullName.trim(),
        phone: phone.replace(/\D/g, ''),
        address: {
          street: address.street.trim(),
          ...(address.street2 && { street2: address.street2.trim() }),
          city: address.city.trim(),
          state: address.state.trim().toUpperCase(),
          zip: address.zip.trim(),
        },
        relationship: relationship.trim(),
        isCoach: isCoach || false,
        aauNumber: isCoach ? aauNumber?.trim() : undefined,
        additionalGuardians: additionalGuardians.map((g) => ({
          ...g,
          phone: g.phone.replace(/\D/g, ''),
          address: {
            street: g.address.street.trim(),
            ...(g.address.street2 && { street2: g.address.street2.trim() }),
            city: g.address.city.trim(),
            state: g.address.state.trim().toUpperCase(),
            zip: g.address.zip.trim(),
          },
        })),
        registerMethod: registerType,
        agreeToTerms: registerType === 'adminCreate' ? true : agreeToTerms,
      };

      const parent = new Parent(parentData);
      await parent.save();

      if (registerType === 'adminCreate') {
        return res.status(201).json({
          message: 'Parent account created successfully',
          parent: {
            _id: parent._id,
            email: parent.email,
            fullName: parent.fullName,
          },
          temporaryPassword: tempPassword,
        });
      }

      const token = generateToken({
        id: parent._id.toString(),
        role: parent.role,
        email: parent.email,
        players: parent.players || [],
        address: parent.address,
      });

      res.status(201).json({
        message: 'Registration successful',
        token,
        parent: {
          _id: parent._id,
          email: parent.email,
          fullName: parent.fullName,
          role: parent.role,
          address: parent.address,
        },
      });
    } catch (error) {
      console.error('Registration error:', error);
      res.status(500).json({
        error: 'Registration failed',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

// Register a new player
router.post(
  '/players/register',
  authenticate,
  [
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('gender').notEmpty().withMessage('Gender is required'),
    body('dob').notEmpty().withMessage('Date of birth is required'),
    body('schoolName').notEmpty().withMessage('School name is required'),
    body('healthConcerns').optional(),
    body('aauNumber').optional(),
    body('registrationYear')
      .isNumeric()
      .withMessage('Registration year must be a number'),
    body('season').notEmpty().withMessage('Season is required'),
    body('parentId').notEmpty().withMessage('Parent ID is required'),
    body('grade').notEmpty().withMessage('Grade is required'),
    body('tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'), // Make tryoutId optional
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log('Validation errors:', errors.array());
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      fullName,
      gender,
      dob,
      schoolName,
      healthConcerns,
      aauNumber,
      registrationYear,
      season,
      parentId,
      grade,
      tryoutId,
    } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // Generate tryoutId if not provided
      const finalTryoutId =
        tryoutId || generateTryoutId(season, registrationYear);

      const existingRegistration = await Registration.findOne({
        player: { $exists: true },
        parent: parentId,
        season,
        year: registrationYear,
        tryoutId: finalTryoutId,
      }).session(session);

      if (existingRegistration) {
        await session.abortTransaction();
        return res
          .status(400)
          .json({ error: 'Player already registered for this tryout' });
      }

      const player = new Player({
        fullName,
        gender,
        dob,
        schoolName,
        healthConcerns: healthConcerns || '',
        aauNumber: aauNumber || '',
        registrationYear,
        season,
        parentId,
        grade,
        seasons: [
          {
            season,
            year: registrationYear,
            tryoutId: finalTryoutId,
            registrationDate: new Date(),
            paymentStatus: 'pending',
          },
        ],
      });

      await player.save({ session });

      await Parent.findByIdAndUpdate(
        parentId,
        { $push: { players: player._id } },
        { new: true, session }
      );

      const registration = new Registration({
        player: player._id,
        parent: parentId,
        season,
        year: registrationYear,
        tryoutId: finalTryoutId,
        paymentStatus: 'pending',
      });

      await registration.save({ session });

      await session.commitTransaction();

      console.log('Registered player:', player);
      console.log('Created registration:', registration);

      res.status(201).json({
        message: 'Player registered successfully',
        player: {
          ...player.toObject(),
          season,
          registrationYear,
          tryoutId: finalTryoutId,
        },
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Error registering player:', error.message, error.stack);
      res
        .status(500)
        .json({ error: 'Failed to register player', details: error.message });
    } finally {
      session.endSession();
    }
  }
);

// Register for basketball camp
router.post(
  '/register/basketball-camp',
  [
    body('email').isEmail().withMessage('Invalid email'),
    body('password')
      .optional()
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('parentInfo.password')
      .optional()
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
    body('fullName').notEmpty().withMessage('Full name is required'),
    body('relationship').notEmpty().withMessage('Relationship is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
    body('address').customSanitizer((value) => {
      if (typeof value === 'string') return parseAddress(value);
      return value;
    }),
    body('address.street').notEmpty().withMessage('Street address is required'),
    body('address.city').notEmpty().withMessage('City is required'),
    body('address.state')
      .isLength({ min: 2, max: 2 })
      .withMessage('State must be 2 letters'),
    body('address.zip').isPostalCode('US').withMessage('Invalid ZIP code'),
    body('isCoach')
      .optional()
      .isBoolean()
      .withMessage('isCoach must be boolean'),
    body('aauNumber').optional().isString(),
    body('agreeToTerms').isBoolean().withMessage('You must agree to the terms'),
    body('players')
      .isArray({ min: 1 })
      .withMessage('At least one player is required'),
    body('players.*.fullName').notEmpty().withMessage('Player name required'),
    body('players.*.gender').notEmpty().withMessage('Player gender required'),
    body('players.*.dob')
      .notEmpty()
      .withMessage('Player date of birth required'),
    body('players.*.schoolName').notEmpty().withMessage('School name required'),
    body('players.*.grade').notEmpty().withMessage('Player grade required'),
    body('players.*.healthConcerns').optional().isString(),
    body('players.*.aauNumber').optional().isString(),
    body('players.*.season').notEmpty().withMessage('Season is required'),
    body('players.*.year')
      .notEmpty()
      .withMessage('Year is required')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030')
      .customSanitizer((value) => parseInt(value, 10)),
    body('players.*.tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array(), success: false });
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const {
        email,
        password,
        parentInfo = {},
        fullName,
        relationship,
        phone,
        address,
        isCoach = false,
        aauNumber = '',
        players,
        agreeToTerms,
        additionalGuardians = [],
      } = req.body;

      const normalizedEmail = email.toLowerCase().trim();
      const existingParent = await Parent.findOne({
        email: normalizedEmail,
      }).session(session);
      if (existingParent) {
        await session.abortTransaction();
        return res
          .status(400)
          .json({ error: 'Email already registered', success: false });
      }

      const rawPassword = (parentInfo.password || password || '').trim();
      if (!rawPassword) {
        await session.abortTransaction();
        return res
          .status(400)
          .json({ error: 'Password is required', success: false });
      }

      const isExistingUser = !!req.body.password;

      if (isExistingUser) {
        for (const player of players) {
          if (player._id) {
            const finalTryoutId =
              player.tryoutId || generateTryoutId(player.season, player.year);
            const existingRegistration = await Registration.findOne({
              player: player._id,
              season: player.season,
              year: player.year,
              tryoutId: finalTryoutId,
            }).session(session);

            if (existingRegistration) {
              await session.abortTransaction();
              return res.status(400).json({
                error: `Player already registered for ${player.season} ${player.year} tryout`,
                success: false,
              });
            }
          }
        }
      }

      // Create parent first to get parentId
      const parent = new Parent({
        email: normalizedEmail,
        password: rawPassword, // Assume password hashing in Parent model's pre-save hook
        fullName: fullName.trim(),
        relationship: relationship.trim(),
        phone: phone.replace(/\D/g, ''),
        address: ensureAddress(address),
        isCoach,
        aauNumber: isCoach ? aauNumber.trim() : '',
        players: [],
        additionalGuardians: additionalGuardians.map((g) => ({
          fullName: g.fullName.trim(),
          relationship: g.relationship.trim(),
          phone: g.phone.replace(/\D/g, ''),
          email: g.email.toLowerCase().trim(),
          address: parseAddress(g.address),
          isCoach: g.isCoach || false,
          aauNumber: g.isCoach ? (g.aauNumber || '').trim() : '',
          registrationComplete: true,
          paymentComplete: false,
        })),
        agreeToTerms,
        role: 'user',
        registrationComplete: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      await parent.save({ session });

      // Create players with parentId
      const playerDocs = players.map((player) => {
        const finalTryoutId =
          player.tryoutId || generateTryoutId(player.season, player.year);
        return {
          _id: new mongoose.Types.ObjectId(),
          fullName: player.fullName.trim(),
          gender: player.gender,
          dob: player.dob,
          schoolName: player.schoolName.trim(),
          grade: player.grade,
          healthConcerns: player.healthConcerns || '',
          aauNumber: player.aauNumber || '',
          season: player.season,
          registrationYear: player.year,
          tryoutId: finalTryoutId,
          parentId: parent._id,
          registrationComplete: true,
          seasons: [
            {
              season: player.season,
              year: player.year,
              tryoutId: finalTryoutId,
              registrationDate: new Date(),
              paymentStatus: 'pending',
            },
          ],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

      const savedPlayers = await Player.insertMany(playerDocs, { session });

      // Update parent with player IDs
      parent.players = savedPlayers.map((p) => p._id);
      await parent.save({ session });

      // Create registration documents
      const registrationDocs = playerDocs.map((playerDoc) => ({
        player: playerDoc._id,
        parent: parent._id,
        season: playerDoc.season,
        year: playerDoc.registrationYear,
        tryoutId: playerDoc.tryoutId,
        paymentStatus: 'pending',
        registrationComplete: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const registrations = await Registration.insertMany(registrationDocs, {
        session,
      });

      await session.commitTransaction();

      // Send welcome email (async, no await)
      sendWelcomeEmail(parent._id, savedPlayers[0]._id).catch((err) =>
        console.error('Welcome email failed:', err)
      );

      const token = generateToken({
        id: parent._id,
        role: parent.role,
        email: parent.email,
        players: parent.players,
        address: parent.address,
        registrationComplete: true,
      });

      res.status(201).json({
        success: true,
        message: 'Registration successful. Please complete payment.',
        registrationStatus: {
          parentRegistered: true,
          paymentCompleted: false,
          nextStep: 'payment',
        },
        parent: {
          id: parent._id,
          email: parent.email,
          fullName: parent.fullName,
          registrationComplete: true,
          paymentComplete: false,
        },
        players: savedPlayers.map((p) => ({
          id: p._id,
          name: p.fullName,
          registrationComplete: true,
          paymentComplete: false,
          tryoutId: p.tryoutId,
        })),
        registrations: registrations.map((r) => ({
          id: r._id,
          playerId: r.player,
          season: r.season,
          year: r.year,
          tryoutId: r.tryoutId,
          paymentStatus: r.paymentStatus,
          registrationComplete: true,
          paymentComplete: false,
        })),
        token,
      });
    } catch (error) {
      await session.abortTransaction();
      console.error('Registration Error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Registration failed',
        registrationStatus: {
          parentRegistered: false,
          paymentCompleted: false,
          error: true,
        },
        details:
          process.env.NODE_ENV === 'development' ? error.stack : undefined,
      });
    } finally {
      session.endSession();
    }
  }
);

// Login
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Invalid email'),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { email, password } = req.body;
      const normalizedEmail = email.toLowerCase().trim();

      const parent = await Parent.findOne({ email: normalizedEmail }).select(
        '+password'
      );

      if (!parent) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        });
      }

      const isMatch = await bcrypt.compare(password.trim(), parent.password);

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        });
      }

      const token = generateToken({
        id: parent._id.toString(),
        role: parent.role,
        email: parent.email,
      });

      const parentData = parent.toObject();
      delete parentData.password;

      res.json({
        success: true,
        token,
        parent: parentData,
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({
        success: false,
        error: 'Server error during login',
      });
    }
  }
);

// Request password reset
router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const parent = await Parent.findOne({ email: email.toLowerCase().trim() });

    if (!parent) {
      return res.json({
        message: 'If an account exists, a reset link has been sent',
      });
    }

    const resetToken = crypto.randomBytes(20).toString('hex');
    parent.resetPasswordToken = resetToken;
    parent.resetPasswordExpires = Date.now() + 3600000;

    await parent.save();

    try {
      await sendResetEmail(parent.email, resetToken);
    } catch (emailError) {
      console.error('Failed to send reset email:', emailError);
      return res.status(500).json({
        error: 'Failed to send reset email',
      });
    }

    res.json({
      message: 'If an account exists, a reset link has been sent',
    });
  } catch (error) {
    console.error('Password reset request error:', error);
    res.status(500).json({
      error: 'Password reset request failed',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Reset password
router.post(
  '/reset-password',
  [
    body('token').notEmpty().withMessage('Token is required'),
    body('newPassword')
      .isLength({ min: 8 })
      .withMessage('Password must be at least 8 characters')
      .matches(/[A-Z]/)
      .withMessage('Password must contain at least one uppercase letter')
      .matches(/\d/)
      .withMessage('Password must contain at least one number')
      .matches(/[@$!%*?&]/)
      .withMessage('Password must contain at least one special character')
      .not()
      .isIn(['12345678', 'password', 'qwertyui'])
      .withMessage('Password is too common'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const token = req.body.token.trim();
      const newPassword = req.body.newPassword.trim();

      const parent = await Parent.findOne({
        resetPasswordToken: token,
        resetPasswordExpires: { $gt: Date.now() },
      });

      if (!parent) {
        return res.status(400).json({ error: 'Invalid or expired token' });
      }

      parent.password = newPassword;
      parent.resetPasswordToken = undefined;
      parent.resetPasswordExpires = undefined;

      await parent.save();

      return res.json({
        success: true,
        message: 'Password updated successfully',
      });
    } catch (error) {
      console.error('Password reset error:', error);
      return res.status(500).json({
        error: 'Password reset failed',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

// Change password
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res
        .status(400)
        .json({ error: 'Current and new password are required' });
    }

    if (newPassword.length < 8) {
      return res
        .status(400)
        .json({ error: 'New password must be at least 8 characters' });
    }

    const parent = await Parent.findById(req.user.id).select('+password');
    if (!parent) {
      return res.status(404).json({ error: 'User not found' });
    }

    const isMatch = await bcrypt.compare(currentPassword, parent.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    parent.password = newPassword;
    await parent.save();

    res.json({
      success: true,
      message: 'Password updated successfully',
    });
  } catch (error) {
    console.error('Password change error:', error);
    res.status(500).json({
      error: 'Password change failed',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Update user role (admin-only endpoint)
router.patch(
  '/update-role/:userId',
  [body('role').isIn(['user', 'admin', 'coach']).withMessage('Invalid role')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId } = req.params;
    const { role } = req.body;

    try {
      const user = await Parent.findById(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      user.role = role;
      await user.save();

      res.json({ message: 'Role updated successfully', user });
    } catch (error) {
      console.error('Role Update Error:', error.message, error.stack);
      res
        .status(500)
        .json({ error: 'Failed to update role', details: error.message });
    }
  }
);

// Fetch Parent data by ID
router.get('/parent/:id', async (req, res) => {
  try {
    const { id } = req.params;

    let parent = await Parent.findById(id)
      .populate('players')
      .populate('additionalGuardians')
      .lean();

    if (!parent) {
      const guardian = await Parent.findOne({
        'additionalGuardians._id': id,
      });

      if (guardian) {
        parent = await Parent.findById(guardian._id)
          .populate('players')
          .populate('additionalGuardians')
          .lean();

        if (!parent) {
          return res
            .status(404)
            .json({ message: 'Parent not found for this guardian' });
        }

        const guardianData = guardian.additionalGuardians.find(
          (g) => g._id.toString() === id
        );
        parent.guardianInfo = guardianData;
      }
    }

    if (!parent) {
      return res.status(404).json({ message: 'Parent not found' });
    }

    parent.playersSeason = parent.playersSeason || [];
    parent.playersYear = parent.playersYear || [];

    res.json(parent);
  } catch (error) {
    console.error('Error fetching parent:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Update Parent data by ID
router.put('/parent/:id', authenticate, async (req, res) => {
  try {
    const {
      fullName,
      phone,
      address,
      relationship,
      email,
      isCoach,
      aauNumber,
    } = req.body;
    const parent = await Parent.findByIdAndUpdate(
      req.params.id,
      { fullName, phone, address, relationship, email, isCoach, aauNumber },
      { new: true }
    );
    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }
    res.json({ message: 'Parent updated successfully', parent });
  } catch (error) {
    console.error('Error updating parent data:', error.message, error.stack);
    res
      .status(500)
      .json({ error: 'Failed to update parent data', details: error.message });
  }
});

// Add/update additional guardians
router.put('/parent/:id/guardian', authenticate, async (req, res) => {
  try {
    const { isCoach, aauNumber, ...guardianData } = req.body;

    if (isCoach && (!aauNumber || aauNumber.trim() === '')) {
      return res
        .status(400)
        .json({ error: 'AAU number is required for coach guardians' });
    }

    const parent = await Parent.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          additionalGuardians: {
            ...guardianData,
            isCoach: isCoach || false,
            aauNumber: isCoach ? aauNumber : '',
          },
        },
      },
      { new: true }
    );

    res.json(parent);
  } catch (error) {
    console.error('Error adding guardian:', error);
    res
      .status(500)
      .json({ error: 'Failed to add guardian', details: error.message });
  }
});

// Update specific guardian
router.put(
  '/parent/:parentId/guardian/:guardianIndex',
  authenticate,
  async (req, res) => {
    try {
      const { parentId, guardianIndex } = req.params;
      const updatedGuardian = req.body;

      const parent = await Parent.findById(parentId);
      if (!parent) {
        return res.status(404).json({ error: 'Parent not found' });
      }

      parent.additionalGuardians[guardianIndex] = updatedGuardian;
      await parent.save();

      res.json({ message: 'Guardian updated successfully', parent });
    } catch (error) {
      console.error('Error updating guardian:', error.message, error.stack);
      res
        .status(500)
        .json({ error: 'Failed to update guardian', details: error.message });
    }
  }
);

// Update all guardians
router.put('/parent/:parentId/guardians', authenticate, async (req, res) => {
  try {
    const { parentId } = req.params;
    const { additionalGuardians } = req.body;

    if (!Array.isArray(additionalGuardians)) {
      return res.status(400).json({ error: 'Guardians data must be an array' });
    }

    const parent = await Parent.findById(parentId);
    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    parent.additionalGuardians = additionalGuardians.map((guardian) => ({
      ...guardian,
      phone: guardian.phone.replace(/\D/g, ''),
      address: ensureAddress(guardian.address),
      isCoach: !!guardian.aauNumber?.trim(),
      aauNumber: (guardian.aauNumber || '').trim(),
    }));

    parent.markModified('additionalGuardians');
    await parent.save();

    res.json({
      message: 'Guardians updated successfully',
      parent,
    });
  } catch (error) {
    console.error('Error updating guardians:', error);
    res.status(500).json({
      error: 'Failed to update guardians',
      details: error.message,
    });
  }
});

// Fetch players by IDs or all players if admin
router.get(
  '/players',
  authenticate,
  [
    query('ids')
      .optional()
      .isString()
      .withMessage('IDs must be a comma-separated string'),
    query('season').optional().isString(),
    query('year').optional().isInt(),
    query('tryoutId').optional().isString(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { ids, season, year, tryoutId } = req.query;
      let query = {};

      if (ids) {
        const playerIds = ids.split(',');
        query._id = { $in: playerIds };
      }

      if (season && year) {
        query['seasons.season'] = season;
        query['seasons.year'] = parseInt(year);
        if (tryoutId) {
          query['seasons.tryoutId'] = tryoutId;
        }
      }

      const players = await Player.find(query)
        .populate('parentId', 'fullName email')
        .lean();

      if (!players || players.length === 0) {
        return res.status(404).json({ error: 'No players found' });
      }

      const response = players.map((player) => ({
        ...player,
        avatar: player.avatar || null,
        imgSrc: player.avatar
          ? `${player.avatar}${player.avatar.includes('?') ? '&' : '?'}ts=${Date.now()}`
          : player.gender === 'Female'
            ? 'https://bothell-select.onrender.com/uploads/avatars/girl.png'
            : 'https://bothell-select.onrender.com/uploads/avatars/boy.png',
      }));

      res.json(response);
    } catch (error) {
      console.error('Error fetching players:', error.message, error.stack);
      res.status(500).json({
        error: 'Failed to fetch players',
        details:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

// Fetch players by tryout
router.get(
  '/players/tryout',
  authenticate,
  [
    query('season').notEmpty().withMessage('Season is required'),
    query('year').isNumeric().withMessage('Year must be a number'),
    query('tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { season, year, tryoutId } = req.query;

      const players = await Player.find({
        'seasons.season': season,
        'seasons.year': parseInt(year),
        'seasons.tryoutId': tryoutId || null,
      })
        .populate('parentId', 'fullName email')
        .lean();

      if (!players || players.length === 0) {
        return res
          .status(404)
          .json({ error: 'No players found for this tryout' });
      }

      res.json(players);
    } catch (error) {
      console.error('Error fetching tryout players:', error);
      res.status(500).json({
        error: 'Failed to fetch tryout players',
        details: error.message,
      });
    }
  }
);

// Fetch player registrations
router.get(
  '/players/:playerId/registrations',
  authenticate,
  async (req, res) => {
    try {
      const { playerId } = req.params;
      const { season, year, tryoutId } = req.query;

      if (!mongoose.Types.ObjectId.isValid(playerId)) {
        return res.status(400).json({
          isRegistered: false,
          message: 'Invalid player ID format',
        });
      }

      if (!season || !year) {
        return res.status(400).json({ error: 'Season and year are required' });
      }

      const query = {
        player: playerId,
        season,
        year: parseInt(year),
      };
      if (tryoutId) {
        query.tryoutId = tryoutId;
      }

      const registrations = await Registration.find(query).populate('player');

      res.json({
        isRegistered: registrations.length > 0,
        registrations,
      });
    } catch (error) {
      console.error('Error fetching registrations:', error);
      res.status(500).json({
        isRegistered: false,
        error: 'Failed to fetch registrations',
        details: error.message,
      });
    }
  }
);

// Fetch guardians for a player
router.get('/player/:playerId/guardians', authenticate, async (req, res) => {
  try {
    const { playerId } = req.params;

    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const guardians = await Parent.find({ players: playerId });

    if (!guardians || guardians.length === 0) {
      return res
        .status(404)
        .json({ error: 'No guardians found for this player' });
    }

    const response = guardians.map((guardian) => ({
      ...guardian.toObject(),
      additionalGuardians: guardian.additionalGuardians || [],
    }));

    res.json(response);
  } catch (error) {
    console.error('Error fetching guardians:', error.message, error.stack);
    res
      .status(500)
      .json({ error: 'Failed to fetch guardians', details: error.message });
  }
});

// Get players by parent ID
router.get(
  ['/parent/:parentId/players', '/players/by-parent/:parentId'],
  authenticate,
  async (req, res) => {
    try {
      const { parentId } = req.params;

      const players = await Player.find({ parentId })
        .populate('seasons')
        .lean();

      if (!players || players.length === 0) {
        return res
          .status(404)
          .json({ error: 'No players found for this parent' });
      }

      res.json(players);
    } catch (error) {
      console.error('Error fetching parent players:', error);
      res.status(500).json({
        error: 'Failed to fetch parent players',
        details: error.message,
      });
    }
  }
);

// Get parents with optional query parameters
router.get('/parents', authenticate, async (req, res) => {
  try {
    const { isCoach, season, year, name, email, phone, status, role } =
      req.query;

    const query = {};

    if (isCoach !== undefined) {
      query.isCoach = isCoach === 'true';
    }
    if (season && year) {
      query['players.season'] = season;
      query['players.year'] = year;
    }

    if (name) {
      query.fullName = { $regex: name, $options: 'i' };
    }

    if (email) {
      query.email = { $regex: email, $options: 'i' };
    }

    if (phone) {
      query.phone = { $regex: phone, $options: 'i' };
    }

    if (status) {
      query.status = status;
    }

    if (role) {
      query.role = role;
    }

    const parents = await Parent.find(query)
      .populate('players')
      .sort({ createdAt: -1 });

    res.json(parents);
  } catch (error) {
    console.error('Error fetching parents:', error);
    res.status(500).json({ error: 'Failed to fetch parents' });
  }
});

// Get coaches
router.get('/coaches', authenticate, async (req, res) => {
  try {
    const coaches = await Parent.find({ isCoach: true })
      .populate('players')
      .sort({ fullName: 1 });

    res.json(coaches);
  } catch (error) {
    console.error('Error fetching coaches:', error);
    res.status(500).json({ error: 'Failed to fetch coaches' });
  }
});

// Update Player data by ID
router.put('/player/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid player ID format' });
    }

    const updatedPlayer = await Player.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updatedPlayer) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json({
      message: 'Player updated successfully',
      player: updatedPlayer,
    });
  } catch (error) {
    console.error('Update error:', error);
    res.status(500).json({
      error: 'Failed to update player',
      details: error.message,
    });
  }
});

// Get all guardians
router.get('/guardians', authenticate, async (req, res) => {
  try {
    const { season, year, name } = req.query;

    const query = {
      $or: [
        { 'additionalGuardians.0': { $exists: true } },
        { isGuardian: true },
      ],
    };

    if (season && year) {
      query['players.season'] = season;
      query['players.year'] = year;
    }

    if (name) {
      query['$or'] = [
        { fullName: { $regex: name, $options: 'i' } },
        { 'additionalGuardians.fullName': { $regex: name, $options: 'i' } },
      ];
    }

    const parentsWithGuardians = await Parent.find(query)
      .populate('players')
      .lean();

    const allGuardians = parentsWithGuardians.flatMap((parent) => {
      const mainGuardian = {
        ...parent,
        _id: parent._id.toString(),
        relationship: parent.relationship || 'Primary Guardian',
        isPrimary: true,
      };

      const additionalGuardians =
        parent.additionalGuardians?.map((g) => ({
          ...g,
          _id: g._id || new mongoose.Types.ObjectId().toString(),
          parentId: parent._id.toString(),
          players: parent.players,
          isPrimary: false,
        })) || [];

      return [mainGuardian, ...additionalGuardians];
    });

    res.json(allGuardians);
  } catch (error) {
    console.error('Error fetching guardians:', error);
    res.status(500).json({ error: 'Failed to fetch guardians' });
  }
});

// Update Parent with Guardians
router.put('/parent-full/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      fullName,
      phone,
      address,
      relationship,
      email,
      isCoach,
      aauNumber,
      additionalGuardians,
      avatarUrl,
      password,
    } = req.body;

    const updateData = {
      fullName,
      phone,
      address,
      relationship,
      email,
      isCoach,
      aauNumber,
      additionalGuardians: additionalGuardians || [],
      avatar: avatarUrl,
    };

    if (password && password.trim().length >= 6) {
      updateData.password = await bcrypt.hash(password.trim(), 12);
    }

    const parent = await Parent.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    res.json({
      message: 'Parent and guardians updated successfully',
      parent,
    });
  } catch (error) {
    console.error('Error updating parent:', error);
    res.status(500).json({
      error: 'Failed to update parent',
      details: error.message,
    });
  }
});

// Get current season and year
router.get('/players/seasons', authenticate, async (req, res) => {
  try {
    const seasons = await Player.aggregate([
      {
        $group: {
          _id: null,
          seasons: {
            $addToSet: {
              season: '$season',
              registrationYear: '$registrationYear',
              tryoutId: '$seasons.tryoutId',
            },
          },
        },
      },
      { $unwind: '$seasons' },
      { $replaceRoot: { newRoot: '$seasons' } },
      { $sort: { registrationYear: -1, season: 1 } },
    ]);

    if (!seasons || seasons.length === 0) {
      return res.status(404).json({ message: 'No seasons found' });
    }

    res.json(seasons);
  } catch (error) {
    console.error('Error fetching seasons:', error);
    res.status(500).json({ message: 'Server error while fetching seasons' });
  }
});

// Get past seasons
router.get('/past-seasons', (req, res) => {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();

  const pastSeasons = [];

  const getSeasonRange = (year, month, day) => {
    if (
      (month === 12 && day >= 21) ||
      month === 1 ||
      month === 2 ||
      (month === 3 && day <= 20)
    ) {
      return {
        season: 'Winter',
        startYear: month === 12 ? year : year - 1,
        endYear: year,
      };
    } else if (
      (month === 3 && day >= 21) ||
      month === 4 ||
      month === 5 ||
      (month === 6 && day <= 20)
    ) {
      return { season: 'Spring', startYear: year, endYear: year };
    } else if (
      (month === 6 && day >= 21) ||
      month === 7 ||
      month === 8 ||
      (month === 9 && day <= 22)
    ) {
      return { season: 'Summer', startYear: year, endYear: year };
    } else if (
      (month === 9 && day >= 23) ||
      month === 10 ||
      month === 11 ||
      (month === 12 && day <= 20)
    ) {
      return { season: 'Fall', startYear: year, endYear: year };
    }
  };

  for (let i = 1; i <= 5; i++) {
    const year = currentYear - i;
    const seasons = [
      getSeasonRange(year, 12, 31),
      getSeasonRange(year, 3, 21),
      getSeasonRange(year, 6, 21),
      getSeasonRange(year, 9, 23),
    ];

    pastSeasons.push(...seasons.filter(Boolean));
  }

  if (pastSeasons.length === 0) {
    return res.status(404).json({ message: 'No past seasons available' });
  }

  res.json(pastSeasons);
});

// Contact form
router.post('/contact', async (req, res) => {
  const { fullName, email, subject, message } = req.body;

  const html = `
    <p><strong>Name:</strong> ${fullName}</p>
    <p><strong>Email:</strong> ${email}</p>
    <p><strong>Message:</strong></p>
    <p>${message}</p>
  `;

  try {
    await sendEmail({
      to: 'bothellselect@proton.me',
      subject: subject || 'New Inquiry from Contact Form',
      html,
    });

    res.status(200).json({ message: 'Inquiry sent successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send inquiry.' });
  }
});

// Send reset email
router.post('/send-reset-email', async (req, res) => {
  const { email, token } = req.body;
  const resetLink = `https://yourfrontend.com/reset-password/${token}`;

  try {
    await sendEmail({
      to: email,
      subject: 'Reset your password',
      html: `<p>Click <a href="${resetLink}">here</a> to reset your password.</p>`,
    });
    res.status(200).send('Reset email sent');
  } catch (err) {
    res.status(500).send('Failed to send email');
  }
});

// Update parent avatar
router.put('/parent/:id/avatar', authenticate, async (req, res) => {
  try {
    const { avatarUrl } = req.body;

    if (!avatarUrl || !avatarUrl.includes('res.cloudinary.com')) {
      return res.status(400).json({ error: 'Invalid avatar URL format' });
    }

    const parent = await Parent.findByIdAndUpdate(
      req.params.id,
      { avatar: avatarUrl },
      { new: true }
    );

    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    res.json({
      success: true,
      parent,
    });
  } catch (error) {
    console.error('Avatar update error:', error);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

// Delete parent avatar
router.delete('/parent/:id/avatar', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findById(req.params.id);

    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    const avatarUrl = parent.avatar;
    if (avatarUrl && avatarUrl.includes('res.cloudinary.com')) {
      const publicId = avatarUrl.split('/').pop().split('.')[0];
      await cloudinary.uploader.destroy(publicId);
    }

    parent.avatar = null;
    await parent.save();

    res.json({
      success: true,
      parent,
    });
  } catch (error) {
    console.error('Avatar deletion error:', error);
    res.status(500).json({ error: 'Failed to delete avatar' });
  }
});

// Update player avatar
router.put('/player/:id/avatar', authenticate, async (req, res) => {
  try {
    const { avatarUrl } = req.body;

    if (!avatarUrl) {
      return res.status(400).json({ error: 'Avatar URL is required' });
    }

    const player = await Player.findByIdAndUpdate(
      req.params.id,
      { avatar: avatarUrl },
      { new: true }
    );

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    console.error('Player avatar update error:', error);
    res.status(500).json({ error: 'Failed to update player avatar' });
  }
});

// Delete player avatar
router.delete('/player/:id/avatar', authenticate, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    const avatarUrl = player.avatar;
    if (avatarUrl && avatarUrl.includes('res.cloudinary.com')) {
      const publicId = avatarUrl.split('/').pop().split('.')[0];
      await cloudinary.uploader.destroy(publicId);
    }

    const defaultAvatar =
      player.gender === 'Female'
        ? 'https://bothell-select.onrender.com/uploads/avatars/girl.png'
        : 'https://bothell-select.onrender.com/uploads/avatars/boy.png';

    player.avatar = defaultAvatar;
    await player.save();

    res.json({
      success: true,
      player,
    });
  } catch (error) {
    console.error('Player avatar deletion error:', error);
    res.status(500).json({ error: 'Failed to delete player avatar' });
  }
});

// Get payments by parent ID
router.get('/payments/parent/:parentId', authenticate, async (req, res) => {
  const { parentId } = req.params;

  try {
    const payments = await Payment.find({ parentId }).sort({ createdAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payments.' });
  }
});

// Update payment status for players
router.post('/payments/update-players', authenticate, async (req, res) => {
  const {
    parentId,
    playerIds,
    season,
    year,
    tryoutId,
    paymentId,
    paymentStatus,
    amountPaid,
    paymentMethod,
    cardLast4,
    cardBrand,
  } = req.body;

  if (!parentId || !playerIds || !season || !year) {
    return res
      .status(400)
      .json({ error: 'Parent ID, player IDs, season, and year are required' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Debug: Log the incoming request body
    console.log('Updating payment status with:', {
      parentId,
      playerIds,
      season,
      year,
      tryoutId,
      paymentStatus,
      paymentId,
      amountPaid,
      cardLast4,
      cardBrand,
    });

    const playersUpdate = await Player.updateMany(
      {
        _id: { $in: playerIds },
        'seasons.season': season,
        'seasons.year': year,
        'seasons.tryoutId': tryoutId || null,
      },
      {
        $set: {
          'seasons.$.paymentComplete': paymentStatus === 'paid',
          'seasons.$.paymentStatus': paymentStatus,
          'seasons.$.amountPaid': amountPaid
            ? amountPaid / playerIds.length
            : undefined,
          'seasons.$.paymentId': paymentId,
          'seasons.$.paymentMethod': paymentMethod,
          'seasons.$.cardLast4': cardLast4,
          'seasons.$.cardBrand': cardBrand,
          paymentComplete: paymentStatus === 'paid',
          paymentStatus,
        },
      },
      { session }
    );

    // Debug: Log the result of players update
    console.log('Players update result:', playersUpdate);

    const registrationsUpdate = await Registration.updateMany(
      {
        player: { $in: playerIds },
        season,
        year,
        tryoutId: tryoutId || null,
      },
      {
        $set: {
          paymentStatus,
          paymentComplete: paymentStatus === 'paid',
          paymentDate: paymentStatus === 'paid' ? new Date() : undefined,
        },
      },
      { session }
    );

    // Debug: Log the result of registrations update
    console.log('Registrations update result:', registrationsUpdate);

    const parentUpdate = await Parent.findByIdAndUpdate(
      parentId,
      {
        $set: {
          paymentComplete: paymentStatus === 'paid',
          updatedAt: new Date(),
        },
      },
      { new: true, session }
    );

    // Debug: Log parent update result
    console.log('Parent update result:', parentUpdate);

    if (
      playersUpdate.modifiedCount === 0 ||
      registrationsUpdate.modifiedCount === 0
    ) {
      await session.abortTransaction();
      return res.status(404).json({
        error: 'No matching players or registrations found',
        details: {
          playersModified: playersUpdate.modifiedCount,
          registrationsModified: registrationsUpdate.modifiedCount,
          query: { playerIds, season, year, tryoutId },
        },
      });
    }

    await session.commitTransaction();

    res.json({
      success: true,
      playersUpdated: playersUpdate.modifiedCount,
      registrationsUpdated: registrationsUpdate.modifiedCount,
      parent: parentUpdate,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Payment status update error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to update payment status',
      details: error.message,
    });
  } finally {
    session.endSession();
  }
});

// Search users
router.get('/users/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const regex = new RegExp(query, 'i');
    const users = await Parent.find({
      $or: [{ fullName: regex }, { email: regex }],
    }).limit(10);

    res.json(users);
  } catch (err) {
    console.error('Error searching users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get available seasons
router.get('/seasons/available', authenticate, async (req, res) => {
  try {
    const seasons = await Player.distinct('season');
    res.json(seasons);
  } catch (err) {
    console.error('Error fetching seasons:', err);
    res.status(500).json({ error: 'Failed to fetch available seasons' });
  }
});

// Get notifications
router.get('/notifications', authenticate, async (req, res) => {
  try {
    const currentUser = req.user;

    let query = {};

    if (currentUser.role !== 'admin') {
      query = {
        $or: [
          { targetType: 'all' },
          {
            targetType: 'individual',
            parentIds: currentUser.id,
          },
          {
            targetType: 'season',
            parentIds: currentUser.id,
          },
        ],
        dismissedBy: { $ne: currentUser.id },
      };
    }

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .populate('parentIds', 'fullName avatar')
      .lean();

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

// Get notifications for a specific user
router.get('/notifications/user/:userId', authenticate, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await Parent.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const notifications = await Notification.find({
      $or: [
        { targetType: 'all' },
        { targetType: 'individual', parentIds: userId },
        {
          targetType: 'season',
          $or: [
            { parentIds: userId },
            { targetSeason: { $in: user.playersSeasons || [] } },
          ],
        },
      ],
      dismissedBy: { $ne: userId },
    })
      .sort({ createdAt: -1 })
      .populate('user', 'fullName avatar')
      .lean();

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({
      error: 'Failed to fetch notifications',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  }
});

// Dismiss a notification
router.patch('/notifications/dismiss/:id', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const notificationId = req.params.id;
    const userId = req.user._id;

    const notification = await Notification.findOne({
      _id: notificationId,
      $or: [{ parentIds: userId }, { targetType: 'all' }],
    }).session(session);

    if (!notification) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ error: 'Notification not found or unauthorized' });
    }

    await Promise.all([
      Notification.findByIdAndUpdate(
        notificationId,
        { $addToSet: { dismissedBy: userId } },
        { session }
      ),
      Parent.findByIdAndUpdate(
        userId,
        { $pull: { notifications: notificationId } },
        { session }
      ),
    ]);

    await session.commitTransaction();

    res.json({
      success: true,
      notificationId,
      dismissedAt: new Date(),
    });
  } catch (error) {
    await session.abortTransaction();
    console.error('Error dismissing notification:', error);
    res.status(500).json({
      error: 'Failed to dismiss notification',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  } finally {
    session.endSession();
  }
});

// Create notification
router.post('/notifications', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      message,
      targetType = 'all',
      targetSeason,
      seasonName,
      parentIds = [],
    } = req.body;

    if (!message) {
      await session.abortTransaction();
      return res.status(400).json({ error: 'Message is required' });
    }

    if (targetType === 'individual' && parentIds.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({
        error: 'Target users are required for individual notifications',
      });
    }

    let resolvedParentIds = [...parentIds];
    const finalSeasonName = seasonName || targetSeason;

    if (targetType === 'season') {
      if (!finalSeasonName) {
        await session.abortTransaction();
        return res.status(400).json({
          error: 'Season name is required for season notifications',
        });
      }

      const players = await Player.find({
        season: { $regex: new RegExp(finalSeasonName, 'i') },
      }).session(session);

      resolvedParentIds = [
        ...new Set(players.map((p) => p.parentId?.toString()).filter(Boolean)),
      ];

      if (resolvedParentIds.length === 0) {
        await session.abortTransaction();
        return res.status(400).json({
          error: `No players found matching season "${finalSeasonName}"`,
          suggestion:
            'Available seasons: ' +
            (await Player.distinct('season')).join(', '),
        });
      }
    }

    const sender = await Parent.findById(req.user.id).select('fullName avatar');

    const notification = new Notification({
      user: req.user._id,
      userFullName: sender.fullName,
      userAvatar: sender.avatar,
      message,
      targetType,
      ...(targetType === 'season' && {
        targetSeason: finalSeasonName,
        seasonName: finalSeasonName,
        parentIds: resolvedParentIds,
      }),
      ...(targetType === 'individual' && {
        parentIds,
      }),
    });

    await notification.save({ session });

    const updateOperation =
      targetType === 'all'
        ? { $push: { notifications: notification._id } }
        : {
            $push: {
              notifications: {
                $each: [notification._id],
                $position: 0,
              },
            },
          };

    await Parent.updateMany(
      targetType === 'all' ? {} : { _id: { $in: resolvedParentIds } },
      updateOperation,
      { session }
    );

    await session.commitTransaction();

    if (req.user.role === 'admin') {
      let emails = [];

      if (targetType === 'all') {
        const parents = await Parent.find({}, 'email');
        emails = parents.map((p) => p.email);
      } else {
        const parents = await Parent.find(
          { _id: { $in: resolvedParentIds } },
          'email'
        );
        emails = parents.map((p) => p.email);
      }

      for (const email of emails) {
        try {
          await sendEmail({
            to: email,
            subject: 'New Notification',
            html: `<p>${message}</p>`,
          });
        } catch (emailError) {
          console.error(`Failed to send email to ${email}:`, emailError);
        }
      }
    }

    res.status(201).json(notification);
  } catch (error) {
    await session.abortTransaction();
    console.error('Error creating notification:', error);
    res.status(500).json({
      error: 'Internal server error',
      details:
        process.env.NODE_ENV === 'development' ? error.message : undefined,
    });
  } finally {
    session.endSession();
  }
});

// Delete individual notification
router.delete('/notifications/:id', async (req, res) => {
  try {
    const notification = await Notification.findByIdAndDelete(req.params.id);

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.status(200).json({
      message: 'Notification deleted successfully',
      notification,
    });
  } catch (error) {
    console.error('Error deleting notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete all notifications
router.delete('/notifications', async (req, res) => {
  try {
    await Notification.deleteMany({});
    res.status(200).json({ message: 'All notifications deleted successfully' });
  } catch (error) {
    console.error('Error deleting all notifications:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark notification as read/unread
router.patch('/notifications/read/:id', async (req, res) => {
  try {
    const { read } = req.body;
    const notification = await Notification.findByIdAndUpdate(
      req.params.id,
      { read },
      { new: true }
    );
    if (!notification) return res.status(404).json({ error: 'Not found' });
    res.json(notification);
  } catch (error) {
    console.error('Error updating read state:', error);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// Mark all notifications as read
router.patch('/notifications/read-all', async (req, res) => {
  try {
    await Notification.updateMany({}, { read: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Error marking all as read:', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

// Update or add season to player
router.patch(
  '/players/:playerId/season',
  authenticate,
  [
    body('season').notEmpty().withMessage('Season is required'),
    body('year')
      .isInt({ min: 2000, max: 2100 })
      .withMessage('Year must be a valid number between 2000 and 2100'),
    body('tryoutId')
      .optional()
      .isString()
      .withMessage('Tryout ID must be a string'),
    body('paymentStatus')
      .optional()
      .isIn(['pending', 'paid', 'failed', 'refunded'])
      .withMessage('Invalid payment status'),
    body('paymentId')
      .optional()
      .isString()
      .withMessage('Payment ID must be a string'),
    body('amountPaid')
      .optional()
      .isFloat({ min: 0 })
      .withMessage('Amount paid must be a non-negative number'),
    body('cardLast4')
      .optional()
      .isString()
      .withMessage('Card last 4 must be a string'),
    body('cardBrand')
      .optional()
      .isString()
      .withMessage('Card brand must be a string'),
    body('updateTopLevel')
      .optional()
      .isBoolean()
      .withMessage('updateTopLevel must be a boolean'),
  ],
  async (req, res) => {
    const startTime = Date.now();
    console.log(
      `[PATCH /players/:playerId/season] Request received for playerId: ${req.params.playerId}`,
      req.body
    );

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      console.log(
        `[PATCH /players/:playerId/season] Validation errors:`,
        errors.array()
      );
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const { playerId } = req.params;
      const {
        season,
        year,
        tryoutId,
        paymentStatus = 'pending',
        paymentId,
        amountPaid,
        cardLast4,
        cardBrand,
        updateTopLevel = true,
      } = req.body;

      const finalTryoutId = tryoutId || generateTryoutId(season, year); // Generate tryoutId if not provided

      if (!mongoose.Types.ObjectId.isValid(playerId)) {
        console.log(
          `[PATCH /players/:playerId/season] Invalid playerId: ${playerId}`
        );
        return res
          .status(400)
          .json({ success: false, error: 'Invalid player ID' });
      }

      const session = await mongoose.startSession();
      session.startTransaction();

      try {
        const player = await Player.findById(playerId).session(session);
        if (!player) {
          console.log(
            `[PATCH /players/:playerId/season] Player not found: ${playerId}`
          );
          await session.abortTransaction();
          return res
            .status(404)
            .json({ success: false, error: 'Player not found' });
        }

        const seasonIndex = player.seasons.findIndex(
          (s) =>
            s.season === season && s.year === year && s.tryoutId === tryoutId
        );

        if (
          seasonIndex !== -1 &&
          player.seasons[seasonIndex].paymentStatus === 'paid'
        ) {
          console.log(
            `[PATCH /players/:playerId/season] Player already paid: ${playerId}`
          );
          await session.abortTransaction();
          return res.status(400).json({
            success: false,
            error: 'Player is already registered and paid for this tryout',
          });
        }

        const seasonData = {
          season,
          year,
          tryoutId: tryoutId || null,
          registrationDate:
            seasonIndex === -1
              ? new Date()
              : player.seasons[seasonIndex].registrationDate,
          paymentStatus,
          paymentComplete: paymentStatus === 'paid',
          ...(paymentId && { paymentId }),
          ...(amountPaid !== undefined && { amountPaid }),
          ...(cardLast4 && { cardLast4 }),
          ...(cardBrand && { cardBrand }),
        };

        if (seasonIndex === -1) {
          player.seasons.push(seasonData);
        } else {
          player.seasons[seasonIndex] = seasonData;
        }

        // Update top-level fields with the latest season's values if updateTopLevel is true
        if (updateTopLevel) {
          const latestSeason = player.seasons.reduce((latest, s) => {
            const currentDate = new Date(s.registrationDate || 0);
            const latestDate = new Date(latest.registrationDate || 0);
            return currentDate > latestDate ? s : latest;
          }, player.seasons[0]);

          player.registrationYear = latestSeason.year;
          player.season = latestSeason.season;
          player.paymentComplete = latestSeason.paymentComplete;
          player.paymentStatus = latestSeason.paymentStatus;
        }

        await player.save({ session });

        const registration = await Registration.findOneAndUpdate(
          {
            player: playerId,
            season,
            year,
            tryoutId: tryoutId || null,
          },
          {
            $set: {
              paymentStatus,
              paymentComplete: paymentStatus === 'paid',
              paymentDate: paymentStatus === 'paid' ? new Date() : undefined,
              ...(paymentId && { paymentId }),
              ...(amountPaid !== undefined && { amountPaid }),
              ...(cardLast4 && { cardLast4 }),
              ...(cardBrand && { cardBrand }),
            },
          },
          { upsert: true, new: true, session }
        );

        await session.commitTransaction();

        console.log(
          `[PATCH /players/:playerId/season] Success for playerId: ${playerId}, duration: ${Date.now() - startTime}ms`
        );

        res.json({
          success: true,
          player: {
            _id: player._id,
            fullName: player.fullName,
            seasons: player.seasons,
            registrationYear: player.registrationYear,
            season: player.season,
            paymentComplete: player.paymentComplete,
            paymentStatus: player.paymentStatus,
          },
          registration,
        });
      } catch (error) {
        await session.abortTransaction();
        console.error(
          `[PATCH /players/:playerId/season] Transaction error:`,
          error
        );
        res.status(500).json({
          success: false,
          error: 'Failed to update season',
          details: error.message,
        });
      } finally {
        session.endSession();
      }
    } catch (error) {
      console.error(`[PATCH /players/:playerId/season] Server error:`, error);
      res.status(500).json({
        success: false,
        error: 'Server error',
        details: error.message,
      });
    }
  }
);

// Error handling middleware
router.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res
    .status(500)
    .json({ error: 'Internal server error', details: err.message });
});

module.exports = router;
