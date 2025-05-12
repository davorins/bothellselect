const Notification = require('../models/Notification');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const mongoose = require('mongoose');

// Helper function to populate notification with user data
const populateNotification = async (notification) => {
  return await Notification.findById(notification._id)
    .populate('user', 'fullName avatar')
    .populate('parentIds', 'fullName avatar')
    .lean();
};

// Mark a notification as read
exports.markAsRead = async (req, res) => {
  const { id } = req.params;
  try {
    const notification = await Notification.findByIdAndUpdate(
      id,
      { read: true },
      { new: true }
    ).populate('user', 'fullName avatar');

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

// Dismiss a notification for current user
exports.dismissNotification = async (req, res) => {
  const { id } = req.params;
  const userId = req.user._id;

  try {
    // Verify notification exists
    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    // Add to user's dismissed notifications
    await Notification.findByIdAndUpdate(
      id,
      { $addToSet: { dismissedBy: userId } },
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

// Get notifications for current user
exports.getNotifications = async (req, res) => {
  try {
    const currentUser = req.user;
    const userObjectId = mongoose.Types.ObjectId(currentUser.id);

    const query = {
      $or: [
        { targetType: 'all' },
        { targetType: 'individual', parentIds: userObjectId },
        { targetType: 'season', parentIds: userObjectId },
      ],
      dismissedBy: { $ne: userObjectId },
    };

    console.log('User ID:', currentUser.id);
    console.log('Query:', JSON.stringify(query, null, 2));

    const notifications = await Notification.find(query)
      .sort({ createdAt: -1 })
      .populate('parentIds', 'fullName avatar')
      .lean();

    console.log('Found notifications:', notifications.length);
    res.json(notifications);
  } catch (error) {
    console.error('Notification fetch error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};

// Create new notification
exports.createNotification = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const {
      message,
      targetType = 'all',
      parentIds = [],
      seasonName,
    } = req.body;

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

    if (targetType === 'season' && seasonName) {
      if (!seasonName) {
        await session.abortTransaction();
        return res.status(400).json({
          error: 'Season name is required for season notifications',
        });
      }

      const players = await Player.find({
        season: { $regex: new RegExp(seasonName, 'i') },
      }).session(session);

      resolvedParentIds = [
        ...new Set(
          players
            .map((p) =>
              p.parentId ? mongoose.Types.ObjectId(p.parentId) : null
            )
            .filter(Boolean)
        ),
      ];
    }

    const notification = new Notification({
      user: req.user._id,
      message,
      targetType,
      parentIds: resolvedParentIds,
      seasonName: targetType === 'season' ? seasonName : undefined,
    });

    await notification.save({ session });

    // Populate the notification with user data
    const populatedNotification = await populateNotification(notification);

    await session.commitTransaction();

    res.status(201).json({
      success: true,
      notification: populatedNotification,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error creating notification:', err);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  } finally {
    session.endSession();
  }
};

// Delete a notification
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

// Delete all notifications
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

// Get dismissed notifications for a specific user
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
