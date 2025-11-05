// middleware/auth.js
const jwt = require('jsonwebtoken');
const Parent = require('../models/Parent');

// Authentication middleware
const requireAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
      return res
        .status(401)
        .json({ message: 'Access denied. No token provided.' });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || 'fallback_secret'
    );
    const user = await Parent.findById(decoded.id).select('-password');

    if (!user) {
      return res.status(401).json({ message: 'Token is invalid.' });
    }

    req.user = user;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ message: 'Token is invalid.' });
  }
};

// Admin middleware
const requireAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ message: 'Access denied. Admin role required.' });
  }
};

// Coach middleware
const requireCoach = (req, res, next) => {
  if (
    req.user &&
    (req.user.role === 'admin' || req.user.role === 'coach' || req.user.isCoach)
  ) {
    next();
  } else {
    res
      .status(403)
      .json({ message: 'Access denied. Coach or Admin role required.' });
  }
};

// Optional auth middleware (doesn't fail if no token, but still sets user if valid token exists)
const optionalAuth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (token) {
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || 'fallback_secret'
      );
      const user = await Parent.findById(decoded.id).select('-password');
      if (user) {
        req.user = user;
      }
    }
    next();
  } catch (error) {
    // If token is invalid, just continue without user
    next();
  }
};

module.exports = {
  requireAuth,
  requireAdmin,
  requireCoach,
  optionalAuth,
};
