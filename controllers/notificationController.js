const Notification = require('../models/Notification');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const mongoose = require('mongoose');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Helper function to populate notification with user data
const populateNotification = async (notification) => {
  return await Notification.findById(notification._id)
    .populate('user', 'fullName avatar')
    .populate('parentIds', 'fullName avatar email')
    .lean();
};

// Send email notifications
const sendEmailNotification = async (emails, message) => {
  try {
    console.log('Attempting to send emails to:', emails);
    console.log('Resolved parent emails to send:', emails);

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2563eb;">New Notification from Bothell Select</h2>
        <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px;">
          <p style="font-size: 16px; line-height: 1.5;">${message}</p>
        </div>
        <p style="margin-top: 20px; font-size: 14px; color: #6b7280;">
          This is an automated message. Please do not reply directly to this email.
        </p>
      </div>
    `;

    const { data, error } = await resend.emails.send({
      from: 'Bothell Select <info@bothellselect.com>',
      to: emails,
      subject: 'New Notification from Bothell Select',
      html: emailHtml,
    });

    if (error) {
      console.error('Resend API error:', error);
      throw error;
    }

    console.log('Email sent successfully:', data);
    return data;
  } catch (err) {
    console.error('Full email sending error:', err);
    throw err;
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
    let parentsToEmail = [];

    // Get recipients based on target type
    if (targetType === 'season' && seasonName) {
      const players = await Player.find({
        season: { $regex: new RegExp(seasonName, 'i') },
      }).session(session);

      resolvedParentIds = [
        ...new Set(
          players
            .map((p) =>
              p.parentId ? new mongoose.Types.ObjectId(p.parentId) : null
            )
            .filter(Boolean)
        ),
      ];
    }

    // Get parent emails
    if (targetType === 'all') {
      parentsToEmail = await Parent.find({}).select('email').session(session);
    } else if (resolvedParentIds.length > 0) {
      parentsToEmail = await Parent.find({
        _id: { $in: resolvedParentIds },
      })
        .select('email')
        .session(session);
    }

    console.log('Parents to email:', parentsToEmail);

    // Create notification
    const notification = new Notification({
      user: req.user._id,
      message,
      targetType,
      parentIds: resolvedParentIds,
      seasonName: targetType === 'season' ? seasonName : undefined,
    });

    await notification.save({ session });

    // Send emails if we have recipients
    let emails = [];

    if (parentsToEmail.length > 0) {
      emails = parentsToEmail
        .map((p) => p.email)
        .filter((email) => {
          const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
          if (!isValid) {
            console.warn('Invalid email skipped:', email);
          }
          return isValid;
        });
    }

    await session.commitTransaction();
    session.endSession();

    // ✅ Send email after DB transaction is committed
    if (emails.length > 0) {
      await sendEmailNotification(emails, message);
    } else {
      console.warn('No valid emails found for notification');
    }

    const populatedNotification = await populateNotification(notification);

    res.status(201).json({
      success: true,
      notification: populatedNotification,
      emailCount: parentsToEmail.length,
    });
  } catch (err) {
    await session.abortTransaction();
    console.error('Error in createNotification:', {
      message: err.message,
      stack: err.stack,
      ...(err.response?.data && { apiError: err.response.data }),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
  } finally {
    session.endSession();
  }
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
