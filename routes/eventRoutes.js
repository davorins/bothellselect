// routes/eventRoutes.js
const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const { authenticate } = require('../utils/auth');

// Get all events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find();
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Get all unique schools
router.get('/schools', async (req, res) => {
  try {
    const events = await Event.find({ 'school.name': { $exists: true } });
    const schools = events.map((e) => e.school).filter(Boolean);
    const uniqueSchools = [...new Map(schools.map((s) => [s.name, s]))].map(
      ([_, s]) => s
    );
    res.json(uniqueSchools);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Create new event
router.post('/', authenticate, async (req, res) => {
  try {
    const event = new Event({
      ...req.body,
      start: new Date(req.body.start),
      end: req.body.end ? new Date(req.body.end) : undefined,
      createdBy: req.user._id,
    });

    const newEvent = await event.save();
    res.status(201).json(newEvent);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Update event
router.put('/:id', authenticate, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Update fields with proper date handling
    event.start = new Date(req.body.start || event.start);
    event.end = req.body.end ? new Date(req.body.end) : event.end;
    // ... other fields

    const updatedEvent = await event.save();
    res.json(updatedEvent);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Delete event
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
