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

// Create new event
router.post('/', authenticate, async (req, res) => {
  const event = new Event({
    title: req.body.title,
    description: req.body.description,
    start: req.body.start,
    end: req.body.end,
    category: req.body.category,
    backgroundColor: req.body.backgroundColor,
    forStudents: req.body.forStudents,
    forStaff: req.body.forStaff,
    classes: req.body.classes,
    sections: req.body.sections,
    roles: req.body.roles,
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
    event.description = req.body.description || event.description;
    event.start = req.body.start || event.start;
    event.end = req.body.end || event.end;
    event.category = req.body.category || event.category;
    event.backgroundColor = req.body.backgroundColor || event.backgroundColor;
    event.forStudents = req.body.forStudents || event.forStudents;
    event.forStaff = req.body.forStaff || event.forStaff;
    event.classes = req.body.classes || event.classes;
    event.sections = req.body.sections || event.sections;
    event.roles = req.body.roles || event.roles;
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
