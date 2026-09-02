const express = require('express');
const router = express.Router();
const EventConfig = require('../models/EventConfig');
const { authenticate, isAdmin } = require('../utils/auth');
const { body, validationResult } = require('express-validator');

// ─── GET public config by event type ──────────────────────────
router.get('/public/:eventType', async (req, res) => {
  try {
    const { eventType } = req.params;

    if (!['tryout', 'training', 'tournament'].includes(eventType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid event type',
      });
    }

    const config = await EventConfig.findOne({
      eventType,
      isActive: true,
    }).lean();

    if (!config) {
      return res.status(404).json({
        success: false,
        error: `No active ${eventType} configuration found`,
      });
    }

    res.json({
      success: true,
      config: {
        ...config,
        registrationOpen: config.registrationOpen || false,
      },
    });
  } catch (error) {
    console.error('Error fetching event config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event configuration',
    });
  }
});

// ─── GET all configs (admin) ──────────────────────────────────
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { eventType } = req.query;
    const filter = {};
    if (eventType) filter.eventType = eventType;

    const configs = await EventConfig.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      success: true,
      configs,
    });
  } catch (error) {
    console.error('Error fetching event configs:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event configurations',
    });
  }
});

// ─── GET single config (admin) ────────────────────────────────
router.get('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const config = await EventConfig.findById(req.params.id).lean();

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Event configuration not found',
      });
    }

    res.json({
      success: true,
      config,
    });
  } catch (error) {
    console.error('Error fetching event config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch event configuration',
    });
  }
});

// ─── CREATE or UPDATE event config ────────────────────────────
router.post(
  '/',
  authenticate,
  isAdmin,
  [
    body('eventType')
      .isIn(['tryout', 'training', 'tournament'])
      .withMessage('Invalid event type'),
    body('title').notEmpty().withMessage('Title is required'),
    body('startDate').isISO8601().withMessage('Invalid start date'),
    body('location.name').notEmpty().withMessage('Location name is required'),
    body('registrationOpen').optional().isBoolean(),
    body('isActive').optional().isBoolean(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const {
        _id,
        eventType,
        title,
        description,
        startDate,
        endDate,
        startTime,
        endTime,
        location,
        gender,
        grades,
        ageGroups,
        price,
        registrationOpen,
        isActive,
        whatToBring,
        whatToExpect,
        importantNotes,
        imageUrl,
        formConfigId,
      } = req.body;

      let config;

      // If we have an _id, update existing
      if (_id) {
        config = await EventConfig.findByIdAndUpdate(
          _id,
          {
            $set: {
              eventType,
              title,
              description,
              startDate,
              endDate,
              startTime,
              endTime,
              location,
              gender,
              grades,
              ageGroups,
              price,
              registrationOpen: registrationOpen || false,
              isActive: isActive !== false,
              whatToBring,
              whatToExpect,
              importantNotes,
              imageUrl,
              formConfigId,
              updatedBy: req.user.id,
            },
          },
          { new: true, runValidators: true },
        );
      } else {
        // If creating a new active config, deactivate others of same type
        if (isActive !== false) {
          await EventConfig.updateMany(
            { eventType, _id: { $ne: null } },
            { $set: { isActive: false } },
          );
        }

        config = new EventConfig({
          eventType,
          title,
          description,
          startDate,
          endDate,
          startTime,
          endTime,
          location,
          gender,
          grades,
          ageGroups,
          price,
          registrationOpen: registrationOpen || false,
          isActive: isActive !== false,
          whatToBring,
          whatToExpect,
          importantNotes,
          imageUrl,
          formConfigId,
          createdBy: req.user.id,
          updatedBy: req.user.id,
        });
        await config.save();
      }

      res.json({
        success: true,
        message: 'Event configuration saved successfully',
        config,
      });
    } catch (error) {
      console.error('Error saving event config:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to save event configuration',
      });
    }
  },
);

// ─── DELETE event config ───────────────────────────────────────
router.delete('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const config = await EventConfig.findByIdAndDelete(req.params.id);

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Event configuration not found',
      });
    }

    res.json({
      success: true,
      message: 'Event configuration deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting event config:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to delete event configuration',
    });
  }
});

module.exports = router;
