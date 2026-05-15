// eventRoutes.js
const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Event = require('../models/Event');
const Form = require('../models/Form');
const Parent = require('../models/Parent');
const { authenticate } = require('../utils/auth');
const FormSubmission = require('../models/FormSubmission');
const { submitPayment } = require('../services/payment-wrapper');
const mongoose = require('mongoose');
const moment = require('moment');
const CalendarDateGenerator = require('../utils/calendarDateGenerator');

// ── GET all events ────────────────────────────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { includeSystem = 'true', year } = req.query;
    let query = {};

    if (includeSystem === 'false') {
      query.$or = [
        { isPredefined: { $ne: true } },
        { source: { $ne: 'system' } },
      ];
    }

    if (year) {
      const startDate = new Date(`${year}-01-01`);
      const endDate = new Date(`${year}-12-31`);
      query.start = { $gte: startDate, $lte: endDate };
    }

    const events = await Event.find(query)
      .populate('formId')
      .sort({ start: 1 });
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET unique schools ────────────────────────────────────────────────────────
router.get('/schools', async (req, res) => {
  try {
    const events = await Event.find({ 'school.name': { $exists: true } });
    const schools = events.map((e) => e.school).filter(Boolean);
    const uniqueSchools = [...new Map(schools.map((s) => [s.name, s]))].map(
      ([_, s]) => s,
    );
    res.json(uniqueSchools);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST batch create (Schedule Builder) ─────────────────────────────────────
// Accepts an array of events and inserts them all in one call.
// Returns { created: N, events: [...] }
router.post('/batch', authenticate, async (req, res) => {
  const eventsPayload = req.body;

  if (!Array.isArray(eventsPayload) || eventsPayload.length === 0) {
    return res
      .status(400)
      .json({
        success: false,
        error: 'Body must be a non-empty array of events',
      });
  }

  if (eventsPayload.length > 500) {
    return res
      .status(400)
      .json({ success: false, error: 'Maximum 500 events per batch' });
  }

  try {
    const docs = eventsPayload.map((ev) => ({
      title: ev.title,
      caption: ev.caption || '',
      price: typeof ev.price === 'number' ? Math.max(0, ev.price) : 0,
      description: ev.description || '',
      start: new Date(ev.start),
      end: ev.end ? new Date(ev.end) : undefined,
      category: ev.category || 'camp',
      backgroundColor: ev.backgroundColor,
      school: ev.school?.name ? ev.school : undefined,
      allDay: ev.allDay || false,
      formId: ev.formId || undefined,
      paymentConfig: ev.paymentConfig || undefined,
      createdBy: req.user._id,
    }));

    const inserted = await Event.insertMany(docs, { ordered: false });

    res.status(201).json({
      success: true,
      created: inserted.length,
      events: inserted,
    });
  } catch (err) {
    // insertMany with ordered:false may partially succeed
    if (err.name === 'BulkWriteError') {
      return res.status(207).json({
        success: false,
        error: 'Partial insert — some events may have failed validation',
        details: err.message,
      });
    }
    res.status(400).json({ success: false, error: err.message });
  }
});

// ── POST single event ─────────────────────────────────────────────────────────
router.post(
  '/',
  authenticate,
  [
    body('title').trim().notEmpty().withMessage('Title is required'),
    body('start').isISO8601().withMessage('Invalid start date'),
    body('end').optional().isISO8601().withMessage('Invalid end date'),
    body('price').optional().isNumeric().withMessage('Price must be a number'),
    body('formId').optional().isMongoId().withMessage('Invalid form ID'),
    body('school').optional().isObject().withMessage('Invalid school object'),
    body('school.name')
      .if(body('school').exists())
      .notEmpty()
      .withMessage('School name is required'),
    body('paymentConfig')
      .optional()
      .isObject()
      .withMessage('Invalid payment configuration'),
    body('paymentConfig.amount')
      .if(body('paymentConfig').exists())
      .isNumeric()
      .withMessage('Payment amount must be a number'),
    body('paymentConfig.description')
      .if(body('paymentConfig').exists())
      .notEmpty()
      .withMessage('Payment description is required'),
    body('paymentConfig.currency')
      .if(body('paymentConfig').exists())
      .isIn(['USD', 'CAD', 'EUR', 'GBP'])
      .withMessage('Invalid currency'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      if (req.body.formId) {
        const form = await Form.findById(req.body.formId);
        if (!form)
          return res
            .status(400)
            .json({ success: false, error: 'Form template not found' });

        const hasPaymentFields = form.fields.some((f) => f.type === 'payment');
        if (hasPaymentFields && !req.body.paymentConfig) {
          return res
            .status(400)
            .json({
              success: false,
              error: 'Payment configuration is required for this form',
            });
        }
      }

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
        formId: req.body.formId,
        paymentConfig: req.body.paymentConfig,
        createdBy: req.user._id,
      });

      const newEvent = await event.save();
      res.status(201).json(newEvent);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// ── PUT update event ──────────────────────────────────────────────────────────
// FIX: uses `!== undefined` checks so fields can be explicitly cleared to ''
router.put(
  '/:id',
  authenticate,
  [
    body('title')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Title cannot be empty'),
    body('start').optional().isISO8601().withMessage('Invalid start date'),
    body('end').optional().isISO8601().withMessage('Invalid end date'),
    body('price').optional().isNumeric().withMessage('Price must be a number'),
    body('formId').optional().isMongoId().withMessage('Invalid form ID'),
    body('paymentConfig')
      .optional()
      .isObject()
      .withMessage('Invalid payment configuration'),
    body('paymentConfig.amount')
      .if(body('paymentConfig').exists())
      .isNumeric()
      .withMessage('Payment amount must be a number'),
    body('paymentConfig.description')
      .if(body('paymentConfig').exists())
      .notEmpty()
      .withMessage('Payment description is required'),
    body('paymentConfig.currency')
      .if(body('paymentConfig').exists())
      .isIn(['USD', 'CAD', 'EUR', 'GBP'])
      .withMessage('Invalid currency'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: 'Event not found' });

      if (req.body.formId && req.body.formId !== event.formId?.toString()) {
        const form = await Form.findById(req.body.formId);
        if (!form)
          return res
            .status(400)
            .json({ success: false, error: 'Form template not found' });

        const hasPaymentFields = form.fields.some((f) => f.type === 'payment');
        if (hasPaymentFields && !req.body.paymentConfig) {
          return res
            .status(400)
            .json({
              success: false,
              error: 'Payment configuration is required for this form',
            });
        }
      }

      // Use !== undefined so callers can explicitly clear optional string fields
      if (req.body.title !== undefined) event.title = req.body.title;
      if (req.body.caption !== undefined) event.caption = req.body.caption;
      if (req.body.price !== undefined) event.price = req.body.price;
      if (req.body.description !== undefined)
        event.description = req.body.description;
      if (req.body.start !== undefined) event.start = req.body.start;
      if (req.body.end !== undefined) event.end = req.body.end;
      if (req.body.category !== undefined) event.category = req.body.category;
      if (req.body.school !== undefined) event.school = req.body.school;
      if (req.body.backgroundColor !== undefined)
        event.backgroundColor = req.body.backgroundColor;
      if (req.body.attendees !== undefined)
        event.attendees = req.body.attendees;
      if (req.body.attachment !== undefined)
        event.attachment = req.body.attachment;
      if (req.body.formId !== undefined) event.formId = req.body.formId;
      if (req.body.paymentConfig !== undefined)
        event.paymentConfig = req.body.paymentConfig;
      event.updatedAt = Date.now();

      const updatedEvent = await event.save();
      res.json(updatedEvent);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  },
);

// ── DELETE event ──────────────────────────────────────────────────────────────
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });
    await FormSubmission.deleteMany({ eventId: req.params.id });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── POST submit form for an event ────────────────────────────────────────────
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('formId');
    if (!event)
      return res
        .status(404)
        .json({ success: false, message: 'Event not found' });
    if (!event.formId || !event.formId._id)
      return res
        .status(400)
        .json({ success: false, message: 'This event has no associated form' });

    const missingFields = event.formId.fields
      .filter((field) => field.required && !req.body[field.id])
      .map((field) => field.label || field.id);

    if (missingFields.length > 0) {
      return res
        .status(400)
        .json({
          success: false,
          message: `Missing required fields: ${missingFields.join(', ')}`,
        });
    }

    const paymentField = event.formId.fields.find((f) => f.type === 'payment');
    let paymentResult = null;

    if (paymentField) {
      if (!req.body.paymentToken)
        return res
          .status(400)
          .json({ success: false, message: 'Payment token is required' });
      try {
        paymentResult = await submitPayment({
          amount: paymentField.paymentConfig.amount,
          currency: paymentField.paymentConfig.currency || 'USD',
          token: req.body.paymentToken,
          description: `Payment for ${event.title}`,
          metadata: {
            eventId: event._id.toString(),
            userId: req.user._id.toString(),
          },
        });
      } catch (paymentError) {
        return res
          .status(402)
          .json({
            success: false,
            message: 'Payment processing failed',
            error: paymentError.message,
          });
      }
    }

    const submission = new FormSubmission({
      eventId: event._id,
      formId: event.formId._id,
      submittedBy: req.user._id,
      data: req.body,
      payment: paymentResult
        ? {
            id: paymentResult.id,
            amount: paymentField.paymentConfig.amount,
            currency: paymentField.paymentConfig.currency || 'USD',
            status: paymentResult.status,
            receiptUrl: paymentResult.receiptUrl,
            processedAt: new Date(),
          }
        : undefined,
    });

    await submission.save();
    res
      .status(201)
      .json({
        success: true,
        data: submission,
        message: 'Form submitted successfully',
      });
  } catch (err) {
    console.error('Form submission error:', err);
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/forms/:id', async (req, res) => {
  try {
    const form = await Form.findById(req.params.id);
    if (!form) return res.status(404).json({ message: 'Form not found' });
    res.json(form);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/payments/process', authenticate, async (req, res) => {
  try {
    const {
      token,
      amount,
      eventId,
      formId,
      buyerEmail,
      buyerName,
      description,
      cardDetails,
      playerId,
      playerCount,
    } = req.body;

    const parent = await Parent.findOne({ userId: req.user._id });
    if (!parent) throw new Error('Parent account not found');
    if (!token) throw new Error('Payment token is required');
    if (!amount || isNaN(amount)) throw new Error('Valid amount is required');
    if (!eventId) throw new Error('Event ID is required');
    if (!formId) throw new Error('Form ID is required');
    if (!buyerEmail) throw new Error('Buyer email is required');
    if (!cardDetails?.last_4) throw new Error('Card details are incomplete');

    const result = await submitPayment(token, amount, {
      parentId: parent._id,
      playerId: playerId || null,
      playerCount: playerCount || null,
      cardDetails,
      locationId: process.env.SQUARE_LOCATION_ID,
      buyerEmailAddress: buyerEmail,
      buyerName: buyerName || '',
      description: description || 'Event registration payment',
      metadata: { eventId, formId, userId: req.user._id.toString() },
    });

    res.json({
      success: true,
      paymentId: result.payment?.squareId || result.payment?.id,
      status: result.payment?.status,
      receiptUrl: result.payment?.receiptUrl,
    });
  } catch (error) {
    console.error('Event payment processing error:', error);
    res
      .status(500)
      .json({
        success: false,
        error: error.message || 'Payment processing failed',
      });
  }
});

// ── Populate system events ────────────────────────────────────────────────────
router.post('/populate-system-events', authenticate, async (req, res) => {
  try {
    const generator = new CalendarDateGenerator(2026);
    const importantDates = generator.getImportantDates();
    const createdEvents = [];
    const systemUserId = new mongoose.Types.ObjectId(
      '000000000000000000000000',
    );

    const existingEvents = await Event.find({
      isPredefined: true,
      source: 'system',
      start: { $gte: new Date('2026-01-01'), $lte: new Date('2026-12-31') },
    });

    const existingTitles = existingEvents.map((e) => e.title);

    for (const dateEvent of importantDates) {
      if (!existingTitles.includes(dateEvent.title)) {
        const event = new Event({
          title: dateEvent.title,
          start: moment(dateEvent.date).toDate(),
          end: dateEvent.endDate
            ? moment(dateEvent.endDate).toDate()
            : moment(dateEvent.date).add(1, 'day').toDate(),
          category: dateEvent.category,
          backgroundColor: dateEvent.backgroundColor,
          isPredefined: true,
          source: 'system',
          recurrence: 'yearly',
          originalDate: dateEvent.date,
          createdBy: systemUserId,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        const savedEvent = await event.save();
        createdEvents.push(savedEvent);
      }
    }

    res.json({
      success: true,
      message: `System events populated for 2026. Created ${createdEvents.length} new events.`,
      events: createdEvents,
    });
  } catch (err) {
    console.error('Error populating system events:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Remove system events ──────────────────────────────────────────────────────
router.delete('/system-events', authenticate, async (req, res) => {
  try {
    const result = await Event.deleteMany({
      source: 'system',
      isPredefined: true,
    });
    res.json({
      success: true,
      message: `Removed ${result.deletedCount} system events`,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── Upcoming important dates ──────────────────────────────────────────────────
router.get('/important-dates', async (req, res) => {
  try {
    const today = moment().startOf('day').toDate();
    const nextMonth = moment().add(1, 'month').endOf('day').toDate();

    const importantDates = await Event.find({
      isPredefined: true,
      source: 'system',
      start: { $gte: today, $lte: nextMonth },
    }).sort({ start: 1 });

    res.json(importantDates);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
