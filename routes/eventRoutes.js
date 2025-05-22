const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Event = require('../models/Event');
const Form = require('../models/Form');
const Parent = require('../models/Parent');
const { authenticate } = require('../utils/auth');
const FormSubmission = require('../models/FormSubmission');
const { submitPayment } = require('../services/square-payments');

// Get all events
router.get('/', async (req, res) => {
  try {
    const events = await Event.find().populate('formId');
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

// Create new event with form validation
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
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    try {
      // Validate form if formId is provided
      if (req.body.formId) {
        const form = await Form.findById(req.body.formId);
        if (!form) {
          return res.status(400).json({
            success: false,
            error: 'Form template not found',
          });
        }

        // If form has payment fields, ensure paymentConfig is provided
        const hasPaymentFields = form.fields.some((f) => f.type === 'payment');
        if (hasPaymentFields && !req.body.paymentConfig) {
          return res.status(400).json({
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
  }
);

// Update event with form validation
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
      return res.status(400).json({
        success: false,
        errors: errors.array(),
      });
    }

    try {
      const event = await Event.findById(req.params.id);
      if (!event) return res.status(404).json({ message: 'Event not found' });

      // Validate form if formId is being updated
      if (req.body.formId && req.body.formId !== event.formId.toString()) {
        const form = await Form.findById(req.body.formId);
        if (!form) {
          return res.status(400).json({
            success: false,
            error: 'Form template not found',
          });
        }

        // If form has payment fields, ensure paymentConfig is provided
        const hasPaymentFields = form.fields.some((f) => f.type === 'payment');
        if (hasPaymentFields && !req.body.paymentConfig) {
          return res.status(400).json({
            success: false,
            error: 'Payment configuration is required for this form',
          });
        }
      }

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
      event.formId = req.body.formId || event.formId;
      event.paymentConfig = req.body.paymentConfig || event.paymentConfig;
      event.updatedAt = Date.now();

      const updatedEvent = await event.save();
      res.json(updatedEvent);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  }
);

// Delete event
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ message: 'Event not found' });

    // Also delete associated form submissions
    await FormSubmission.deleteMany({ eventId: req.params.id });

    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Submit form for an event
router.post('/:id/submit', authenticate, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('formId');
    if (!event) {
      return res.status(404).json({
        success: false,
        message: 'Event not found',
      });
    }

    // Check if event has a form
    if (!event.formId || !event.formId._id) {
      return res.status(400).json({
        success: false,
        message: 'This event has no associated form',
      });
    }

    // Validate required fields
    const missingFields = event.formId.fields
      .filter((field) => field.required && !req.body[field.id])
      .map((field) => field.label || field.id);

    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
      });
    }

    // Process payment if payment field exists
    const paymentField = event.formId.fields.find((f) => f.type === 'payment');
    let paymentResult = null;

    if (paymentField) {
      if (!req.body.paymentToken) {
        return res.status(400).json({
          success: false,
          message: 'Payment token is required',
        });
      }

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
        return res.status(402).json({
          success: false,
          message: 'Payment processing failed',
          error: paymentError.message,
        });
      }
    }

    // Save form submission
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

    res.status(201).json({
      success: true,
      data: submission,
      message: 'Form submitted successfully',
    });
  } catch (err) {
    console.error('Form submission error:', err);
    res.status(400).json({
      success: false,
      message: err.message,
    });
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

    // Get parentId from authenticated user
    const parent = await Parent.findOne({ userId: req.user._id });
    if (!parent) throw new Error('Parent account not found');

    // Validate required fields
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
      metadata: {
        eventId,
        formId,
        userId: req.user._id.toString(),
      },
    });

    res.json({
      success: true,
      paymentId: result.payment?.squareId || result.payment?.id,
      status: result.payment?.status,
      receiptUrl: result.payment?.receiptUrl,
    });
  } catch (error) {
    console.error('Event payment processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Payment processing failed',
    });
  }
});

module.exports = router;
