const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');

// Existing routes
router.patch('/notifications/read/:id', notificationController.markAsRead);
router.patch('/notifications/read-all', notificationController.markAllAsRead);

// New route to dismiss a notification
router.post(
  '/notifications/dismiss/:id',
  notificationController.dismissNotification
);

// New route to get dismissed notifications for a user
router.get(
  '/notifications/dismissed/:userId',
  notificationController.getDismissedNotifications
);

module.exports = router;
