const Notification = require('../models/Notification');
const User = require('../models/Parent');

// Mark a notification as read
exports.markAsRead = async (req, res) => {
  const { id } = req.params;
  try {
    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).send('Notification not found');
    }

    notification.read = true;
    await notification.save();
    res.status(200).send('Notification marked as read');
  } catch (err) {
    console.error('Error marking notification as read:', err);
    res.status(500).send('Internal server error');
  }
};

// Mark all notifications as read
exports.markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany({ read: false }, { read: true });
    res.status(200).send('All notifications marked as read');
  } catch (err) {
    console.error('Error marking all notifications as read:', err);
    res.status(500).send('Internal server error');
  }
};

// Dismiss a notification
exports.dismissNotification = async (req, res) => {
  const { id } = req.params;
  const { userId } = req.body; // Assuming the user ID is passed in the request body

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('User not found');
    }

    // Check if the notification exists before dismissing it
    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).send('Notification not found');
    }

    // If the user hasn't already dismissed this notification, add it to their dismissedNotifications array
    if (!user.dismissedNotifications.includes(id)) {
      user.dismissedNotifications.push(id);
      await user.save();
    }

    res.status(200).send('Notification dismissed');
  } catch (err) {
    console.error('Error dismissing notification:', err);
    res.status(500).send('Internal server error');
  }
};

// Get dismissed notifications for a user
exports.getDismissedNotifications = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('User not found');
    }

    res.status(200).json(user.dismissedNotifications); // Returns the array of dismissed notification IDs
  } catch (err) {
    console.error('Error fetching dismissed notifications:', err);
    res.status(500).send('Internal server error');
  }
};

// Get notifications for a specific user
exports.getNotifications = async (req, res) => {
  const { userId } = req.params;

  try {
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).send('User not found');
    }

    // Fetch notifications that have not been dismissed by this user
    const notifications = await Notification.find({
      _id: { $nin: user.dismissedNotifications }, // Exclude dismissed notifications
    }).sort({ createdAt: -1 }); // Optional: Sort by creation date if needed

    res.status(200).json(notifications);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).send('Internal server error');
  }
};
