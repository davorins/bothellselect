const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult, query } = require('express-validator');
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
const mongoose = require('mongoose');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const {
  sendEmail,
  sendWelcomeEmail,
  sendResetEmail,
} = require('../utils/email');

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
        password: plainPassword, // <-- Only raw, never hash here
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
        seasons: [
          {
            season: req.body.season,
            year: req.body.registrationYear,
            registrationDate: new Date(),
            paymentStatus: 'pending',
          },
        ],
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
        player: {
          ...player.toObject(),
          season: req.body.season,
          registrationYear: req.body.registrationYear,
        },
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

      // Create player documents with registration status
      const playerDocs = players.map((player) => {
        const _id = new mongoose.Types.ObjectId();
        return {
          _id,
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
        };
      });

      const savedPlayers = await Player.insertMany(playerDocs, { session });

      // Create parent with registration status
      const parent = new Parent({
        email: normalizedEmail,
        password: rawPassword,
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
      const registrationDocs = playerDocs.map((playerDoc) => ({
        player: playerDoc._id,
        parent: parent._id,
        season: playerDoc.season,
        year: playerDoc.registrationYear,
        paymentStatus: 'pending',
        registrationComplete: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      const registrations = await Registration.insertMany(registrationDocs, {
        session,
      });

      await session.commitTransaction();

      // Send welcome email (non-blocking) AFTER transaction is committed
      sendWelcomeEmail(parent._id, savedPlayers[0]._id).catch((err) =>
        console.error('Welcome email failed:', err)
      );

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

      // Find parent by email with password field included
      const parent = await Parent.findOne({ email: normalizedEmail }).select(
        '+password'
      );

      if (!parent) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        });
      }

      // Compare passwords
      const isMatch = await bcrypt.compare(password.trim(), parent.password);
      console.log('Comparing password:', password);
      console.log('With stored hash:', parent.password);
      console.log('Password match result:', isMatch);

      if (!isMatch) {
        return res.status(401).json({
          success: false,
          error: 'Invalid email or password',
        });
      }

      // Generate token
      const token = generateToken({
        id: parent._id.toString(),
        role: parent.role,
        email: parent.email,
      });

      // Return response without password
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

router.post('/request-password-reset', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const parent = await Parent.findOne({ email: email.toLowerCase().trim() });

    // Always return success to prevent email enumeration
    if (!parent) {
      return res.json({
        message: 'If an account exists, a reset link has been sent',
      });
    }

    // Generate reset token (expires in 1 hour)
    const resetToken = crypto.randomBytes(20).toString('hex');
    parent.resetPasswordToken = resetToken;
    parent.resetPasswordExpires = Date.now() + 3600000; // 1 hour

    await parent.save();

    // Send email with reset link
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

      parent.password = newPassword; // ✅ Let the pre-save hook hash it
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

router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    // Validate input
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

    // Get parent
    const parent = await Parent.findById(req.user.id).select('+password');
    if (!parent) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, parent.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // ✅ Assign plain new password, let the pre-save hook hash it
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

// Fetch Parent data by ID - Enhanced version
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

router.put('/parent/:parentId/guardians', authenticate, async (req, res) => {
  try {
    const { parentId } = req.params;
    const { additionalGuardians } = req.body;

    if (!Array.isArray(additionalGuardians)) {
      return res.status(400).json({ error: 'Guardians data must be an array' });
    }

    // Find the parent document first
    const parent = await Parent.findById(parentId);
    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    // Process and update guardians
    parent.additionalGuardians = additionalGuardians.map((guardian) => ({
      ...guardian,
      phone: guardian.phone.replace(/\D/g, ''),
      address: ensureAddress(guardian.address),
      isCoach: !!guardian.aauNumber?.trim(),
      aauNumber: (guardian.aauNumber || '').trim(),
    }));

    // Explicitly mark the array as modified
    parent.markModified('additionalGuardians');

    // Save the document
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

// Fetch multiple players by IDs or all players if admin
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
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { ids, season, year } = req.query;
      let query = {};

      // Handle IDs filter
      if (ids) {
        const playerIds = ids.split(',');
        query._id = { $in: playerIds };
      }

      // Handle season/year filter
      if (season && year) {
        query.season = season;
        query.registrationYear = parseInt(year);
      }

      const players = await Player.find(query).lean();

      if (!players || players.length === 0) {
        return res.status(404).json({ error: 'No players found' });
      }

      // Transform response to ensure consistent avatar URLs
      const response = players.map((player) => ({
        ...player,
        // Preserve raw avatar URL exactly as stored
        avatar: player.avatar || null,
        // Add additional fields that might be needed by frontend
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
router.get(
  ['/parent/:parentId/players', '/players/by-parent/:parentId'],
  authenticate,
  async (req, res) => {
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
  }
);

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

//RESEND
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

// AVATAR UPDATE ENDPOINT (Cloudinary URL)
router.put('/parent/:id/avatar', authenticate, async (req, res) => {
  try {
    const { avatarUrl } = req.body;

    // Validate URL format
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
      parent, // Return full parent object
    });
  } catch (error) {
    console.error('Avatar update error:', error);
    res.status(500).json({ error: 'Failed to update avatar' });
  }
});

router.get('/parent/:id', async (req, res) => {
  try {
    const parent = await Parent.findById(req.params.id);
    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    res.json({ parent });
  } catch (error) {
    console.error('Error fetching parent:', error);
    res.status(500).json({ error: 'Failed to fetch parent info' });
  }
});

// AVATAR DELETION ENDPOINT
router.delete('/parent/:id/avatar', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findById(req.params.id);

    if (!parent) {
      return res.status(404).json({ error: 'Parent not found' });
    }

    // If the parent has an avatar with a Cloudinary URL, delete it from Cloudinary
    const avatarUrl = parent.avatar;
    if (avatarUrl && avatarUrl.includes('res.cloudinary.com')) {
      const publicId = avatarUrl.split('/').pop().split('.')[0]; // Assumes no folder structure
      await cloudinary.uploader.destroy(publicId); // Delete the image from Cloudinary
    }

    // Remove avatar from MongoDB
    parent.avatar = null; // or use `$unset: { avatar: 1 }` if you prefer
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

// Add these routes to your authRoutes.js file

// PLAYER AVATAR UPDATE ENDPOINT (Cloudinary URL)
router.put('/player/:id/avatar', authenticate, async (req, res) => {
  try {
    const { avatarUrl } = req.body;

    // Validate URL format
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
      player, // Return full player object
    });
  } catch (error) {
    console.error('Player avatar update error:', error);
    res.status(500).json({ error: 'Failed to update player avatar' });
  }
});

// PLAYER AVATAR DELETION ENDPOINT
router.delete('/player/:id/avatar', authenticate, async (req, res) => {
  try {
    const player = await Player.findById(req.params.id);

    if (!player) {
      return res.status(404).json({ error: 'Player not found' });
    }

    // If the player has an avatar with a Cloudinary URL, delete it from Cloudinary
    const avatarUrl = player.avatar;
    if (avatarUrl && avatarUrl.includes('res.cloudinary.com')) {
      const publicId = avatarUrl.split('/').pop().split('.')[0]; // Assumes no folder structure
      await cloudinary.uploader.destroy(publicId); // Delete the image from Cloudinary
    }

    // Remove avatar from MongoDB and set to default based on gender
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

router.get('/payments/parent/:parentId', authenticate, async (req, res) => {
  const { parentId } = req.params;

  try {
    const payments = await Payment.find({ parentId }).sort({ createdAt: -1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payments.' });
  }
});

router.post('/payments/update-players', authenticate, async (req, res) => {
  const { parentId, playerIds } = req.body;

  if (!parentId || !playerIds) {
    return res
      .status(400)
      .json({ error: 'Parent ID and player IDs are required' });
  }

  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Update players' payment status
    const playersUpdate = await Player.updateMany(
      { _id: { $in: playerIds } },
      {
        $set: {
          paymentComplete: true,
          paymentStatus: 'paid',
          updatedAt: new Date(),
        },
      },
      { session }
    );

    // Update registrations
    const registrationsUpdate = await Registration.updateMany(
      { player: { $in: playerIds } },
      {
        $set: {
          paymentStatus: 'paid',
          paymentComplete: true,
          paymentDate: new Date(),
        },
      },
      { session }
    );

    // Update parent
    const parentUpdate = await Parent.findByIdAndUpdate(
      parentId,
      {
        $set: {
          paymentComplete: true,
          updatedAt: new Date(),
        },
      },
      { new: true, session }
    );

    await session.commitTransaction();

    res.json({
      success: true,
      playersUpdated: playersUpdate.nModified,
      registrationsUpdated: registrationsUpdate.nModified,
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

router.get('/users/search', async (req, res) => {
  const query = req.query.q;
  if (!query) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const regex = new RegExp(query, 'i'); // case-insensitive search
    const users = await Parent.find({
      $or: [{ firstName: regex }, { lastName: regex }, { email: regex }],
    }).limit(10); // Limit results to 10

    res.json(users);
  } catch (err) {
    console.error('Error searching users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET available seasons
router.get('/seasons/available', authenticate, async (req, res) => {
  try {
    const seasons = await Player.distinct('season');
    res.json(seasons);
  } catch (err) {
    console.error('Error fetching seasons:', err);
    res.status(500).json({ error: 'Failed to fetch available seasons' });
  }
});

router.get('/notifications', authenticate, async (req, res) => {
  try {
    const currentUser = req.user;

    let query = {};

    // For non-admin users, apply filters
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
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ✅ GET: Notifications visible to a specific user (excluding dismissed)
router.get('/notifications/user/:userId', authenticate, async (req, res) => {
  try {
    const userId = req.params.userId;
    const user = await Parent.findById(userId);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get all notifications that either:
    // 1. Are targeted to this user specifically
    // 2. Are general notifications
    // 3. Are season notifications matching user's seasons
    const notifications = await Notification.find({
      $or: [
        { targetType: 'all' },
        { targetType: 'individual', parentIds: userId },
        {
          targetType: 'season',
          $or: [
            { parentIds: userId },
            {
              // Match if user has players in any of the notification's seasons
              targetSeason: { $in: user.playersSeasons || [] },
            },
          ],
        },
      ],
      dismissedBy: { $ne: userId },
    })
      .sort({ createdAt: -1 })
      .populate('user', 'fullName avatar')
      .lean();

    res.json(notifications);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({
      error: 'Failed to fetch notifications',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  }
});

// ✅ PATCH: Dismiss a single notification for a specific user
router.patch('/notifications/dismiss/:id', authenticate, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const notificationId = req.params.id;
    const userId = req.user._id;

    // Verify the notification exists and user should have access to it
    const notification = await Notification.findOne({
      _id: notificationId,
      $or: [
        { parentIds: userId }, // User is in parentIds
        { targetType: 'all' }, // Or it's a general notification
      ],
    }).session(session);

    if (!notification) {
      await session.abortTransaction();
      return res
        .status(404)
        .json({ error: 'Notification not found or unauthorized' });
    }

    // Update both notification and parent document atomically
    await Promise.all([
      // Add to notification's dismissedBy
      Notification.findByIdAndUpdate(
        notificationId,
        { $addToSet: { dismissedBy: userId } },
        { session }
      ),

      // Remove from parent's notifications
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
  } catch (err) {
    await session.abortTransaction();
    console.error('Error dismissing notification:', err);
    res.status(500).json({
      error: 'Failed to dismiss notification',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    session.endSession();
  }
});

// ✅ (Optional) GET: Fetch dismissed notifications (for debugging)
router.get('/notifications/dismissed/:userId', async (req, res) => {
  try {
    const user = await Parent.findById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json(user.dismissedNotifications || []);
  } catch (err) {
    console.error('Error fetching dismissed notifications:', err);
    res.status(500).json({ error: 'Failed to fetch dismissed notifications' });
  }
});

// ✅ POST: New notification
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

    // Validation
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

      // Find players by season name (partial match)
      const players = await Player.find({
        season: { $regex: new RegExp(finalSeasonName, 'i') }, // Case-insensitive partial match
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

    // ✅ Only send emails if the user is an admin
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

      // Send email notifications using the sendEmail function
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
  } catch (err) {
    await session.abortTransaction();
    console.error('Error creating notification:', err);
    res.status(500).json({
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    session.endSession();
  }
});

// ✅ DELETE: Individual notification
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
  } catch (err) {
    console.error('Error deleting notification:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ DELETE: All notifications
router.delete('/notifications', async (req, res) => {
  try {
    await Notification.deleteMany({});
    res.status(200).json({ message: 'All notifications deleted successfully' });
  } catch (err) {
    console.error('Error deleting all notifications:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ PATCH: Mark a single notification as read/unread
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
  } catch (err) {
    console.error('Error updating read state:', err);
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

// ✅ PATCH: Mark all notifications as read
router.patch('/notifications/read-all', async (req, res) => {
  try {
    await Notification.updateMany({}, { read: true });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Error marking all as read:', err);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

router.post('/players/:playerId/season', authenticate, async (req, res) => {
  try {
    const { season, year, paymentStatus } = req.body;
    const { playerId } = req.params;

    const player = await Player.findById(playerId);
    if (!player) {
      return res.status(404).json({ message: 'Player not found' });
    }

    // Add new season registration
    player.seasons.push({
      season,
      year,
      registrationDate: new Date(),
      paymentStatus: paymentStatus || 'pending',
    });

    // Update top-level fields to match the latest season
    player.season = season;
    player.registrationYear = year;

    await player.save();

    res.json({
      success: true,
      player: {
        _id: player._id,
        fullName: player.fullName,
        season: player.season,
        registrationYear: player.registrationYear,
        seasons: player.seasons,
      },
    });
  } catch (error) {
    console.error('Season registration error:', error);
    res.status(500).json({
      message: 'Server error',
      error: error.message,
    });
  }
});

module.exports = router;
