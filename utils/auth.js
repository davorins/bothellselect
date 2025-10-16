const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const Parent = require('../models/Parent');
dotenv.config();

const saltRounds = 12;

// Password Hashing
const hashPassword = async (password) => {
  if (!password) throw new Error('Password is required');
  const trimmedPassword = String(password).trim();
  if (trimmedPassword.length < 6) throw new Error('Password too short');
  return await bcrypt.hash(trimmedPassword, saltRounds);
};

// Password Comparison
const comparePasswords = async (inputPassword, hashedPassword) => {
  if (!inputPassword || !hashedPassword) {
    console.error('Comparison failed - missing arguments');
    return false;
  }

  const cleanPassword = String(inputPassword);

  console.log('Comparison details:', {
    cleanPassword,
    cleanPasswordLength: cleanPassword.length,
    hashedPassword: hashedPassword.substring(0, 10) + '...',
  });

  return await bcrypt.compare(cleanPassword, hashedPassword);
};

// Token Generation
const generateToken = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in the environment variables.');
  }

  return jwt.sign(
    {
      id: user._id || user.id,
      role: user.role,
      email: user.email,
      players: user.players || [],
      isCoach: user.isCoach || false,
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Token Verification
const verifyToken = (token) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in the environment variables.');
  }
  return jwt.verify(token, process.env.JWT_SECRET);
};

// Improved Authentication Middleware
const authenticate = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Authentication token missing',
      });
    }

    // Verify token
    const decoded = verifyToken(token);
    console.log('Decoded token:', decoded);

    // Find user in Parent collection
    const user = await Parent.findById(decoded.id).select('-password');

    console.log('User lookup result:', user);

    if (!user) {
      console.error(`User not found with ID: ${decoded.id}`);
      return res.status(401).json({
        success: false,
        message: 'User not found',
      });
    }

    // Attach full user object to request
    req.user = user;
    next();
  } catch (error) {
    console.error('Authentication error:', error);

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token',
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Token expired',
      });
    }

    return res.status(500).json({
      success: false,
      message: 'Authentication failed',
    });
  }
};

// Role Middlewares
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Admin access required',
    });
  }
  next();
};

const isCoach = (req, res, next) => {
  if (!req.user.isCoach && req.user.role !== 'admin') {
    return res.status(403).json({
      success: false,
      error: 'Coach access required',
    });
  }
  next();
};

const isUser = (req, res, next) => {
  if (
    req.user.role !== 'user' &&
    req.user.role !== 'admin' &&
    !req.user.isCoach
  ) {
    return res.status(403).json({
      success: false,
      error: 'User access required',
    });
  }
  next();
};

// Check if coach can access specific parent data
// Coaches can only access their own data and data of parents whose players are on their teams
const canAccessParent = async (currentUserId, targetParentId) => {
  try {
    // If user is trying to access their own data, allow it
    if (currentUserId.toString() === targetParentId.toString()) {
      return true;
    }

    const currentUser = await Parent.findById(currentUserId);
    const targetParent =
      await Parent.findById(targetParentId).populate('players');

    if (!currentUser || !targetParent) {
      console.log('User or target parent not found');
      return false;
    }

    // If current user is not a coach, they can't access other parents' data
    if (!currentUser.isCoach && currentUser.role !== 'admin') {
      return false;
    }

    // Admins can access everything
    if (currentUser.role === 'admin') {
      return true;
    }

    // Coaches logic: check if they share teams/players
    // This assumes you have a way to link coaches to players/teams
    // For now, coaches can only access their own data
    console.log(
      `Coach ${currentUserId} cannot access parent ${targetParentId} data`
    );
    return false;
  } catch (error) {
    console.error('Error checking coach access:', error);
    return false;
  }
};

// Check if user can access payment
const canAccessPayment = async (req, res, next) => {
  try {
    const paymentId = req.params.paymentId || req.body.paymentId;

    if (!paymentId) {
      return res.status(400).json({
        success: false,
        error: 'Payment ID required',
      });
    }

    // Find the payment to get the parentId
    const Payment = require('../models/Payment');
    const payment = await Payment.findById(paymentId);

    if (!payment) {
      return res.status(404).json({
        success: false,
        error: 'Payment not found',
      });
    }

    // Admins can access everything
    if (req.user.role === 'admin') {
      return next();
    }

    // Users/Coaches can only access their own payments
    if (payment.parentId.toString() === req.user._id.toString()) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'Access denied to this payment',
    });
  } catch (error) {
    console.error('Error in canAccessPayment:', error);
    return res.status(500).json({
      success: false,
      error: 'Access check failed',
    });
  }
};

// Check if user can access parent data
const canAccessParentData = async (req, res, next) => {
  try {
    const targetParentId = req.params.parentId || req.body.parentId;

    if (!targetParentId) {
      return res.status(400).json({
        success: false,
        error: 'Parent ID required',
      });
    }

    // Admins can access everything
    if (req.user.role === 'admin') {
      return next();
    }

    // Users/Coaches can only access their own data
    if (targetParentId.toString() === req.user._id.toString()) {
      return next();
    }

    return res.status(403).json({
      success: false,
      error: 'Access denied to this parent data',
    });
  } catch (error) {
    console.error('Error in canAccessParentData:', error);
    return res.status(500).json({
      success: false,
      error: 'Access check failed',
    });
  }
};

module.exports = {
  hashPassword,
  comparePasswords,
  generateToken,
  verifyToken,
  authenticate,
  isAdmin,
  isCoach,
  isUser,
  canAccessParent,
  canAccessPayment,
  canAccessParentData,
};
