const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const { authenticate } = require('../utils/auth');

// Notification visibility and status routes
router.patch(
  '/notifications/read/:id',
  authenticate,
  notificationController.markAsRead
);

router.patch(
  '/notifications/read-all',
  authenticate,
  notificationController.markAllAsRead
);

// User-specific notification dismissal
router.patch(
  '/notifications/dismiss/:id',
  authenticate,
  notificationController.dismissNotification
);

// Get notifications (filtered by user's dismissed ones)
router.get(
  '/notifications',
  authenticate,
  notificationController.getNotifications
);

// Admin-only notification management routes
router.post(
  '/notifications',
  authenticate,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  notificationController.createNotification
);

router.delete(
  '/notifications/:id',
  authenticate,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  notificationController.deleteNotification
);

router.delete(
  '/notifications',
  authenticate,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  notificationController.deleteAllNotifications
);

// Admin route to view dismissed notifications for a specific user (optional for debugging)
router.get(
  '/notifications/dismissed/:userId',
  authenticate,
  (req, res, next) => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  },
  notificationController.getDismissedNotifications
);

module.exports = router;
