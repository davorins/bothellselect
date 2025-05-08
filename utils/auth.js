const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
const Parent = require('../models/Parent'); // Make sure to import your Parent model
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
    console.log('Decoded token:', decoded); // Debugging

    // Find user in database
    const user = await Parent.findById(decoded.id).select('-password');
    console.log('User lookup result:', user); // Debugging

    if (!user) {
      console.error(`User not found with ID: ${decoded.id}`); // Debugging
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
    // ... rest of error handling
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
  if (req.user.role !== 'coach') {
    return res.status(403).json({
      success: false,
      error: 'Coach access required',
    });
  }
  next();
};

const isUser = (req, res, next) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({
      success: false,
      error: 'User access required',
    });
  }
  next();
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
};
