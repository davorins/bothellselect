const Notification = require('../models/Notification');
const Parent = require('../models/Parent');

// Mark a notification as read
exports.markAsRead = async (req, res) => {
  const { id } = req.params;
  try {
    const notification = await Notification.findByIdAndUpdate(
      id,
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Notification marked as read',
      notification,
    });
  } catch (err) {
    console.error('Error marking notification as read:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Mark all notifications as read for current user
exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany({ read: false }, { read: true });

    res.status(200).json({
      success: true,
      message: 'All notifications marked as read',
    });
  } catch (err) {
    console.error('Error marking all notifications as read:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Dismiss a notification for current user (alias for dismissForUser)
exports.dismissNotification = exports.dismissForUser = async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id; // Get user ID from authenticated request

  try {
    // Verify notification exists
    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Add to user's dismissed notifications
    await Parent.findByIdAndUpdate(
      userId,
      { $addToSet: { dismissedNotifications: id } },
      { new: true }
    );

    res.status(200).json({
      success: true,
      message: 'Notification dismissed',
    });
  } catch (err) {
    console.error('Error dismissing notification:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Get notifications for current user (filtering out dismissed ones)
exports.getNotifications = async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await Parent.findById(userId);

    const query = user?.dismissedNotifications?.length
      ? { _id: { $nin: user.dismissedNotifications } }
      : {};

    const notifications = await Notification.find(query).sort({
      createdAt: -1,
    });

    res.status(200).json({
      success: true,
      count: notifications.length,
      notifications,
    });
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Admin-only: Create new notification
exports.createNotification = async (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const notification = new Notification({
      user: req.user._id,
      message,
      read: false,
    });

    await notification.save();

    res.status(201).json({
      success: true,
      notification,
    });
  } catch (err) {
    console.error('Error creating notification:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Admin-only: Delete a notification
exports.deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const notification = await Notification.findByIdAndDelete(id);

    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Notification deleted successfully',
    });
  } catch (err) {
    console.error('Error deleting notification:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Admin-only: Delete all notifications
exports.deleteAllNotifications = async (req, res) => {
  try {
    await Notification.deleteMany({});

    res.status(200).json({
      success: true,
      message: 'All notifications deleted successfully',
    });
  } catch (err) {
    console.error('Error deleting all notifications:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};

// Admin-only: Get dismissed notifications for a specific user
exports.getDismissedNotifications = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await Parent.findById(userId).select('dismissedNotifications');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.status(200).json({
      success: true,
      dismissedNotifications: user.dismissedNotifications || [],
    });
  } catch (err) {
    console.error('Error fetching dismissed notifications:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};
