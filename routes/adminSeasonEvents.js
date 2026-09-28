const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const SeasonEvent = require('../models/SeasonEvent');
const { authenticate, isAdmin } = require('../utils/auth');

/**
 * GET /api/admin/season-events
 * List all seasons with current state.
 */
router.get('/season-events', authenticate, isAdmin, async (req, res) => {
  try {
    const events = await SeasonEvent.find({})
      .sort({ year: -1, startDate: -1 })
      .lean();
    res.json({ success: true, events });
  } catch (err) {
    console.error('Error fetching season events:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * PATCH /api/admin/season-events/:eventId
 * Update one or more flags on a season event.
 * Body: { registrationOpen?, isActive?, isActiveOverride? }
 */
router.patch(
  '/season-events/:eventId',
  authenticate,
  isAdmin,
  async (req, res) => {
    try {
      const { eventId } = req.params;
      const { registrationOpen, isActive, isActiveOverride } = req.body;

      const update = {};
      if (typeof registrationOpen === 'boolean')
        update.registrationOpen = registrationOpen;
      if (typeof isActive === 'boolean') update.isActive = isActive;
      if (isActiveOverride) update.isActiveOverride = isActiveOverride;

      // Audit trail
      update.lastModifiedBy = req.user.id;
      update.lastModifiedAt = new Date();

      const event = await SeasonEvent.findOneAndUpdate(
        { eventId },
        { $set: update },
        { new: true },
      );

      if (!event) {
        return res
          .status(404)
          .json({ success: false, error: 'Season event not found' });
      }

      console.log(
        `[admin] ${req.user.email} updated season ${eventId}:`,
        update,
      );

      res.json({ success: true, event });
    } catch (err) {
      console.error('Error updating season event:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

/**
 * POST /api/admin/season-events
 * Create a new season event.
 */
router.post('/season-events', authenticate, isAdmin, async (req, res) => {
  try {
    const { eventId, season, year, startDate, endDate, description } = req.body;

    if (!eventId || !season || !year) {
      return res.status(400).json({
        success: false,
        error: 'eventId, season, and year are required',
      });
    }

    const existing = await SeasonEvent.findOne({ eventId });
    if (existing) {
      return res.status(400).json({
        success: false,
        error: `Season event "${eventId}" already exists`,
      });
    }

    const event = new SeasonEvent({
      eventId,
      season,
      year,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      description,
      registrationOpen: false, // start closed by default
      isActive: false, // start inactive by default
      createdBy: req.user.id,
    });

    await event.save();
    console.log(`[admin] ${req.user.email} created season ${eventId}`);

    res.status(201).json({ success: true, event });
  } catch (err) {
    console.error('Error creating season event:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/season-events/stats
 * Quick counts for the dashboard panel — how many players per season, etc.
 */
router.get('/season-events/stats', authenticate, isAdmin, async (req, res) => {
  try {
    const Player = require('../models/Player');

    const events = await SeasonEvent.find({}).lean();

    const stats = await Promise.all(
      events.map(async (event) => {
        const paidCount = await Player.countDocuments({
          seasons: {
            $elemMatch: { tryoutId: event.eventId, paymentComplete: true },
          },
        });
        const totalCount = await Player.countDocuments({
          seasons: { $elemMatch: { tryoutId: event.eventId } },
        });
        return {
          eventId: event.eventId,
          paidCount,
          totalCount,
        };
      }),
    );

    res.json({ success: true, stats });
  } catch (err) {
    console.error('Error fetching season stats:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
