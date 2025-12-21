const express = require('express');
const router = express.Router();
const { authenticate } = require('../utils/auth');
const Parent = require('../models/Parent');

// Get user's communication preferences
router.get('/', authenticate, async (req, res) => {
  try {
    const parent = await Parent.findById(req.user.id);

    if (!parent) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Ensure communicationPreferences exists with defaults
    const preferences = parent.communicationPreferences || {
      emailNotifications: true,
      newsUpdates: true,
      offersPromotions: true,
      marketingEmails: true,
      transactionalEmails: true,
      broadcastEmails: true,
      lastUpdated: new Date(),
    };

    res.json({
      success: true,
      data: { preferences },
    });
  } catch (error) {
    console.error('Error fetching communication preferences:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to fetch preferences' });
  }
});

// Update communication preferences
router.put('/', authenticate, async (req, res) => {
  try {
    const { preferences } = req.body;

    if (!preferences || typeof preferences !== 'object') {
      return res.status(400).json({
        success: false,
        error: 'Preferences object is required',
      });
    }

    const validPreferences = [
      'emailNotifications',
      'newsUpdates',
      'offersPromotions',
      'marketingEmails',
      'transactionalEmails',
      'broadcastEmails',
    ];

    const updateData = {};

    // Validate and prepare update
    for (const key of validPreferences) {
      if (preferences[key] !== undefined) {
        if (typeof preferences[key] !== 'boolean') {
          return res.status(400).json({
            success: false,
            error: `Preference ${key} must be a boolean`,
          });
        }
        updateData[`communicationPreferences.${key}`] = preferences[key];
      }
    }

    // Always update the lastUpdated timestamp
    updateData['communicationPreferences.lastUpdated'] = new Date();

    const parent = await Parent.findByIdAndUpdate(
      req.user.id,
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!parent) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    res.json({
      success: true,
      data: {
        preferences: parent.communicationPreferences || {
          emailNotifications: true,
          newsUpdates: true,
          offersPromotions: true,
          marketingEmails: true,
          transactionalEmails: true,
          broadcastEmails: true,
          lastUpdated: new Date(),
        },
        message: 'Communication preferences updated successfully',
      },
    });
  } catch (error) {
    console.error('Error updating communication preferences:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to update preferences' });
  }
});

module.exports = router;
