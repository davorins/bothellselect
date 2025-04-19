const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult, query } = require('express-validator');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const {
  comparePasswords,
  hashPassword,
  generateToken,
  authenticate,
} = require('../utils/auth');
const { sendResetEmail } = require('../services/emailService');
const mongoose = require('mongoose');

const registrationSchema = new mongoose.Schema({
  player: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Player',
    required: true,
  },
  season: { type: String, required: true },
  year: { type: Number, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Registration = mongoose.model('Registration', registrationSchema);

const router = express.Router();

// Generate random password for admin-created accounts
const generateRandomPassword = () => {
  return (
    Math.random().toString(36).slice(-10) +
    Math.random().toString(36).slice(-10)
  );
};

module.exports = {
  hashPassword,
  comparePasswords,
  generateRandomPassword,
};

const addressUtils = {
  /**
   * Parses an address from string or object format
   * @param {string|object} addressInput
   * @returns {object} Normalized address
   */
  parseAddress: (addressInput) => {
    // Handle object case
    if (typeof addressInput !== 'string') {
      return {
        street: (addressInput.street || '').trim(),
        street2: (addressInput.street2 || '').trim(),
        city: (addressInput.city || '').trim(),
        state: (addressInput.state || '').trim(),
        zip: (addressInput.zip || '').toString().replace(/\D/g, ''),
      };
    }

    // Handle empty string case
    if (!addressInput.trim()) {
      return {
        street: '',
        street2: '',
        city: '',
        state: '',
        zip: '',
      };
    }

    // String parsing logic
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

  /**
   * Ensures valid address structure
   * @param {string|object|undefined} address
   * @returns {object} Valid address
   */
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

// Destructure for easier use
const { parseAddress, ensureAddress } = addressUtils;

// Register a new parent
router.post(
  '/register',
  [
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
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
    // Only validate agreeToTerms for self-registration
    body('agreeToTerms')
      .if((value, { req }) => req.body.registerType === 'self')
      .isBoolean()
      .withMessage('You must agree to the terms')
      .equals(true)
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

      // Handle password properly based on registration type
      let passwordHash;
      let tempPassword;

      if (registerType === 'adminCreate') {
        tempPassword = generateRandomPassword();
        passwordHash = tempPassword.trim();
      } else {
        if (!password) {
          return res.status(400).json({ error: 'Password is required' });
        }
        passwordHash = password.trim();
      }

      // Validate coach requirements
      if (isCoach && (!aauNumber || aauNumber.trim() === '')) {
        return res
          .status(400)
          .json({ error: 'AAU number required for coaches' });
      }

      const parentData = {
        email: normalizedEmail,
        password: passwordHash,
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
        id: parent._id,
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
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
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
    } = req.body;

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
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
      });

      await player.save();

      // Update the parent's players array
      await Parent.findByIdAndUpdate(
        parentId,
        { $push: { players: player._id } },
        { new: true }
      );

      // Create registration record
      const registration = new Registration({
        player: player._id,
        parent: parentId,
        season,
        year: registrationYear,
        paymentStatus: 'pending',
      });

      await registration.save({ session });

      await session.commitTransaction();

      res.status(201).json({
        message: 'Player registered successfully',
        player,
        registration,
      });
    } catch (error) {
      console.error('Error registering player:', error.message, error.stack);
      res
        .status(500)
        .json({ error: 'Failed to register player', details: error.message });
    }
  }
);

router.use('/register/basketball-camp', (req, res, next) => {
  if (Array.isArray(req.body.players)) {
    req.body.players = req.body.players.map((p) => ({
      ...p,
      year: p.year ?? p.registrationYear,
    }));
  }
  next();
});

// Register for basketball camp
router.post(
  '/register/basketball-camp',
  [
    // Parent validation
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
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

    // Players validation
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
    body('players.*.season')
      .notEmpty()
      .withMessage('Season is required')
      .isIn(['Spring', 'Summer', 'Fall', 'Winter'])
      .withMessage('Invalid season'),
    body('players.*.year')
      .notEmpty()
      .withMessage('Year is required')
      .isInt({ min: 2020, max: 2030 })
      .withMessage('Year must be between 2020 and 2030')
      .customSanitizer((value) => parseInt(value, 10)),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
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
        throw new Error('Email already registered');
      }

      const rawPassword = (parentInfo.password || password || '').trim();
      if (!rawPassword) {
        throw new Error('Password is required');
      }
      const passwordHash = await hashPassword(rawPassword);

      // Create player documents with registration status
      const playerDocs = players.map((player) => ({
        fullName: player.fullName.trim(),
        gender: player.gender,
        dob: player.dob,
        schoolName: player.schoolName.trim(),
        grade: player.grade,
        healthConcerns: player.healthConcerns || '',
        aauNumber: player.aauNumber || '',
        season: player.season,
        registrationYear: player.year,
        parentId: null,
        registrationComplete: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const savedPlayers = await Player.insertMany(playerDocs, { session });

      // Create parent with registration status
      const parent = new Parent({
        email: normalizedEmail,
        password: passwordHash,
        fullName: fullName.trim(),
        relationship: relationship.trim(),
        phone: phone.replace(/\D/g, ''),
        address: ensureAddress(address),
        isCoach,
        aauNumber: isCoach ? aauNumber.trim() : '',
        players: savedPlayers.map((p) => p._id),
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

      // Update players with parent ID
      await Player.updateMany(
        { _id: { $in: savedPlayers.map((p) => p._id) } },
        { parentId: parent._id },
        { session }
      );

      // Create registration records with status
      const registrationDocs = players.map((player, index) => ({
        player: savedPlayers[index]._id,
        parent: parent._id,
        season: player.season,
        year: player.year,
        paymentStatus: 'pending',
        registrationComplete: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const registrations = await Registration.insertMany(registrationDocs, {
        session,
      });

      // Generate token with status information
      const token = generateToken({
        id: parent._id,
        role: parent.role,
        email: parent.email,
        players: parent.players,
        address: parent.address,
        registrationComplete: true,
      });

      await session.commitTransaction();

      // Successful response with status information
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
        })),
        registrations: registrations.map((r) => ({
          id: r._id,
          playerId: r.player,
          season: r.season,
          year: r.year,
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

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('Invalid email').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const trimmedPassword = req.body.password.trim();

    // Check if password is provided after trimming
    if (!trimmedPassword) {
      return res.status(400).json({ error: 'Password is required' });
    }

    try {
      const normalizedEmail = req.body.email.toLowerCase().trim();
      const rawPassword = req.body.password;
      const trimmedPassword = String(rawPassword).trim();

      console.log('Login attempt details:', {
        email: normalizedEmail,
        rawPasswordLength: rawPassword.length,
        trimmedPasswordLength: trimmedPassword.length,
      });

      const parent = await Parent.findOne({ email: normalizedEmail }).select(
        '+password'
      );

      if (!parent) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      console.log(
        'Stored password hash:',
        parent.password.substring(0, 10) + '...'
      );

      const isMatch = await comparePasswords(trimmedPassword, parent.password);
      console.log('Comparison result:', isMatch);

      const token = generateToken({
        id: parent._id.toString(),
        role: parent.role,
        email: parent.email,
      });

      res.json({
        success: true,
        token,
        parent: {
          _id: parent._id.toString(),
          email: parent.email,
          fullName: parent.fullName,
          role: parent.role,
        },
      });
    } catch (error) {
      console.error('Login error:', error.message, error.stack);
      res.status(500).json({
        error: 'Server error',
        message:
          process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
);

router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;
    const parent = await Parent.findOne({ email: email.toLowerCase().trim() });

    if (!parent) {
      return res.status(404).json({ error: 'Email not found' });
    }

    // Generate reset token (expires in 1 hour)
    const resetToken = crypto.randomBytes(20).toString('hex');
    parent.resetPasswordToken = resetToken;
    parent.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await parent.save();

    // Send email with reset link
    await sendResetEmail(parent.email, resetToken);

    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;
    const parent = await Parent.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() },
    });

    if (!parent) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Update password
    parent.password = await hashPassword(newPassword.trim());
    parent.resetPasswordToken = undefined;
    parent.resetPasswordExpires = undefined;
    await parent.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Password reset error:', error);
    res.status(500).json({ error: 'Password reset failed' });
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

// Fetch Parent data by ID - Enhanced version
// In authRoutes.js - Update the parent detail endpoint
router.get('/parent/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // First try to find as parent
    let parent = await Parent.findById(id)
      .populate('players')
      .populate('additionalGuardians')
      .lean();

    // If not found as parent, check if it's a guardian ID
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

        // Add guardian-specific info to the response
        const guardianData = guardian.additionalGuardians.find(
          (g) => g._id.toString() === id
        );
        parent.guardianInfo = guardianData;
      }
    }

    if (!parent) {
      return res.status(404).json({ message: 'Parent not found' });
    }

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

// When adding/updating additional guardians
router.put('/parent/:id/guardian', authenticate, async (req, res) => {
  try {
    const { isCoach, aauNumber, ...guardianData } = req.body;

    // Validate coach data
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
    // ... error handling
  }
});

router.put(
  '/parent/:parentId/guardian/:guardianIndex',
  authenticate,
  async (req, res) => {
    try {
      const { parentId, guardianIndex } = req.params;
      const updatedGuardian = req.body;

      // Find the parent by ID
      const parent = await Parent.findById(parentId);
      if (!parent) {
        return res.status(404).json({ error: 'Parent not found' });
      }

      // Update the specific guardian in the additionalGuardians array
      parent.additionalGuardians[guardianIndex] = updatedGuardian;

      // Save the updated parent document
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

// Fetch multiple players by IDs or all players if admin
router.get(
  '/players',
  authenticate,
  [
    query('ids')
      .optional()
      .isString()
      .withMessage('IDs must be a comma-separated string'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { ids } = req.query;
      let players;

      if (ids) {
        const playerIds = ids.split(',');
        players = await Player.find({ _id: { $in: playerIds } });
      } else {
        players = await Player.find({});
      }

      if (!players || players.length === 0) {
        return res.status(404).json({ error: 'No players found' });
      }

      res.json(players);
    } catch (error) {
      console.error('Error fetching players:', error.message, error.stack);
      res
        .status(500)
        .json({ error: 'Failed to fetch players', details: error.message });
    }
  }
);

// Improve error responses
router.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message, err.stack);
  res
    .status(500)
    .json({ error: 'Internal server error', details: err.message });
});

// Add this route to your Express router
router.get(
  '/players/:playerId/registrations',
  authenticate,
  async (req, res) => {
    try {
      const { playerId } = req.params;
      const { season, year } = req.query;

      // Validate playerId
      if (!mongoose.Types.ObjectId.isValid(playerId)) {
        return res.status(400).json({
          isRegistered: false,
          message: 'Invalid player ID format',
        });
      }

      if (!season || !year) {
        return res.status(400).json({ error: 'Season and year are required' });
      }

      const registrations = await Registration.find({
        player: playerId,
        season,
        year,
      }).populate('player');

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

// Add this route to your Express router
router.get('/player/:playerId/guardians', authenticate, async (req, res) => {
  try {
    const { playerId } = req.params;

    // Fetch the player to ensure they exist
    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // Fetch guardians associated with the player
    const guardians = await Parent.find({ players: playerId });

    if (!guardians || guardians.length === 0) {
      return res
        .status(404)
        .json({ error: 'No guardians found for this player' });
    }

    // Include additionalGuardians in the response
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
router.get('/parent/:parentId/players', authenticate, async (req, res) => {
  try {
    const { parentId } = req.params;

    const players = await Player.find({ parentId });

    if (!players || players.length === 0) {
      return res
        .status(404)
        .json({ error: 'No players found for this parent' });
    }

    res.json(players);
  } catch (error) {
    console.error('Error fetching parent players:', error);
    res.status(500).json({ error: 'Failed to fetch parent players' });
  }
});

// Get parents with optional query parameters
router.get('/parents', authenticate, async (req, res) => {
  try {
    const { isCoach, season, year, name, email, phone, status, role } =
      req.query;

    const query = {};

    // Add isCoach filter if provided
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

    // Debug log
    console.log(`Attempting to update player with ID: ${id}`);
    console.log('Update payload:', req.body);

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

// Get all guardians (both primary parents and additional guardians)
router.get('/guardians', authenticate, async (req, res) => {
  try {
    const { season, year, name } = req.query;

    // Find all parents who have additional guardians or are marked as guardians
    const query = {
      $or: [
        { 'additionalGuardians.0': { $exists: true } }, // Parents with additional guardians
        { isGuardian: true }, // Or parents marked as guardians
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

    // Extract and flatten all guardians (both primary parents and additional guardians)
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

    // Prepare update data
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

    // Find and update the parent
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
  console.log('GET /api/past-seasons hit');
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();

  const pastSeasons = [];

  // Helper function to get season range
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

  // Generate past seasons for the last 5 years
  for (let i = 1; i <= 5; i++) {
    const year = currentYear - i;
    const seasons = [
      getSeasonRange(year, 12, 31), // Winter
      getSeasonRange(year, 3, 21), // Spring
      getSeasonRange(year, 6, 21), // Summer
      getSeasonRange(year, 9, 23), // Fall
    ];

    pastSeasons.push(...seasons.filter(Boolean)); // Filter out undefined values
  }

  if (pastSeasons.length === 0) {
    return res.status(404).json({ message: 'No past seasons available' });
  }

  res.json(pastSeasons);
});

router.get('/all', authenticate, async (req, res) => {
  try {
    const searchTerm = req.query.q;
    if (!searchTerm) return res.json([]);

    const [players, parents, coaches, schoolNames] = await Promise.all([
      Player.find({
        $or: [{ fullName: { $regex: searchTerm, $options: 'i' } }],
      })
        .select('fullName gender dob grade schoolName profileImage')
        .limit(5),
      Parent.find({
        isCoach: false,
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
            schoolName: {
              $regex: searchTerm,
              $options: 'i',
              $exists: true,
              $ne: null,
            },
          },
        },
        { $group: { _id: '$schoolName', playerCount: { $sum: 1 } } },
        { $sort: { playerCount: -1 } },
        { $limit: 5 },
      ]),
    ]);

    // Format results directly in the backend
    const results = [
      ...players.map((p) => ({
        id: p._id,
        type: 'player',
        name: p.fullName,
        dob: p.dob ? p.dob.toISOString().split('T')[0] : 'N/A',
        grade: p.grade || 'N/A',
        gender: p.gender || 'N/A',
        aauNumber: p.aauNumber || 'N/A',
        email: p.email || '',
        image: p.profileImage || 'assets/img/profiles/avatar-27.jpg',
        additionalInfo: p.schoolName || 'No school specified',
        createdAt: p.createdAt,
      })),

      ...parents.map((p) => ({
        id: p._id,
        type: 'parent',
        name: p.fullName,
        email: p.email || '',
        image: p.profileImage || 'assets/img/profiles/avatar-27.jpg',
      })),

      ...coaches.map((c) => ({
        id: c._id,
        type: 'coach',
        name: c.fullName,
        email: c.email || '',
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
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
