const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
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

  const cleanPassword = String(inputPassword).trim();

  console.log('Comparison details:', {
    cleanPassword,
    cleanPasswordLength: cleanPassword.length,
    hashedPassword: hashedPassword.substring(0, 10) + '...', // Log partial hash for security
  });

  return await bcrypt.compare(cleanPassword, hashedPassword);
};

// Token Generation (using your provided function)
const generateToken = (user) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in the environment variables.');
  }

  return jwt.sign(
    {
      id: user._id,
      role: user.role,
      email: user.email,
      players: user.players || [],
    },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// Token Verification (using your provided function)
const verifyToken = (token) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in the environment variables.');
  }
  return jwt.verify(token, process.env.JWT_SECRET);
};

// Authentication Middleware (using your provided function)
const authenticate = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' });
  }

  try {
    const decoded = verifyToken(token);
    req.user = decoded;
    next();
  } catch (error) {
    console.error('Token verification error:', error.message);
    res.status(400).json({ error: 'Invalid token' });
  }
};

// Role Middlewares (using your provided functions)
const isAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Access denied. Admins only.' });
  }
  next();
};

const isCoach = (req, res, next) => {
  if (req.user.role !== 'coach') {
    return res.status(403).json({ error: 'Access denied. Coaches only.' });
  }
  next();
};

const isUser = (req, res, next) => {
  if (req.user.role !== 'user') {
    return res.status(403).json({ error: 'Access denied. Users only.' });
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
