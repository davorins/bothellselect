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
  const event = new Event({
    title: req.body.title,
    caption: req.body.caption,
    price: req.body.price,
    description: req.body.description,
    start: req.body.start,
    end: req.body.end,
    category: req.body.category,
    school: req.body.school,
    backgroundColor: req.body.backgroundColor,
    attendees: req.body.attendees,
    attachment: req.body.attachment,
    createdBy: req.user._id,
  });

  try {
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

    // Update fields
    event.title = req.body.title || event.title;
    event.caption = req.body.caption || event.caption;
    event.price = req.body.price || event.price;
    event.description = req.body.description || event.description;
    event.start = req.body.start || event.start;
    event.end = req.body.end || event.end;
    event.category = req.body.category || event.category;
    event.school = req.body.school || event.school;
    event.backgroundColor = req.body.backgroundColor || event.backgroundColor;
    event.attendees = req.body.attendees || event.attendees;
    event.attachment = req.body.attachment || event.attachment;
    event.updatedAt = Date.now();

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
