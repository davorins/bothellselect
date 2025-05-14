const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const EmailTemplate = require('../models/EmailTemplate');
const Parent = require('../models/Parent');

const { authenticate } = require('../utils/auth');
const { sendEmail } = require('../utils/email');
const { replaceTemplateVariables } = require('../utils/templateHelpers');

// 🔐 Middleware for admin-only routes
const authorizeAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }
  next();
};

// ✅ Create a new email template
router.post(
  '/',
  authenticate,
  authorizeAdmin,
  [
    body('title').notEmpty().withMessage('Title is required'),
    body('subject').notEmpty().withMessage('Subject is required'),
    body('content').notEmpty().withMessage('Content is required'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const template = new EmailTemplate({
        ...req.body,
        createdBy: req.user.id,
      });
      await template.save();

      res.status(201).json({ success: true, data: template });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

// ✅ Get all templates
router.get('/', authenticate, async (req, res) => {
  try {
    const templates = await EmailTemplate.find({});
    res.json({ success: true, data: templates });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Get template by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: 'Template not found' });
    }

    res.json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Update template
router.put(
  '/:id',
  authenticate,
  authorizeAdmin,
  [
    body('title')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Title cannot be empty'),
    body('subject')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Subject cannot be empty'),
    body('content')
      .optional()
      .trim()
      .notEmpty()
      .withMessage('Content cannot be empty'),
    body('status')
      .optional()
      .isBoolean()
      .withMessage('Status must be a boolean'),
    body('variables')
      .optional()
      .isArray()
      .withMessage('Variables must be an array'),
    body('category')
      .optional()
      .isIn(['system', 'marketing', 'transactional', 'notification', 'other'])
      .withMessage('Invalid category'),
    body('tags').optional().isArray().withMessage('Tags must be an array'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: errors.array(),
      });
    }

    try {
      const template = await EmailTemplate.findById(req.params.id);
      if (!template) {
        return res.status(404).json({
          success: false,
          error: 'Template not found',
        });
      }

      // Only update allowed fields
      const updates = Object.keys(req.body);
      updates.forEach((update) => {
        template[update] = req.body[update];
      });

      await template.save();

      res.json({
        success: true,
        data: template,
      });
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error.message,
        ...(error.errors && {
          validationErrors: Object.keys(error.errors),
        }),
      });
    }
  }
);

// ✅ Delete template
router.delete('/:id', authenticate, authorizeAdmin, async (req, res) => {
  try {
    const template = await EmailTemplate.findByIdAndDelete(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: 'Template not found' });
    }

    res.json({ success: true, data: template });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ Send email using a template
router.post(
  '/send-template',
  authenticate,
  [
    body('templateId').notEmpty().withMessage('templateId is required'),
    body('parentId').notEmpty().withMessage('parentId is required'),
    body('playerId').notEmpty().withMessage('playerId is required'),
  ],
  async (req, res) => {
    const { templateId, parentId, playerId } = req.body;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    try {
      const template = await EmailTemplate.findById(templateId);
      if (!template) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }

      const parent = await Parent.findById(parentId);
      if (!parent) {
        return res
          .status(404)
          .json({ success: false, error: 'Parent not found' });
      }

      const populatedContent = await replaceTemplateVariables(
        template.content,
        {
          parentId,
          playerId,
        }
      );

      await sendEmail({
        to: parent.email,
        subject: template.subject,
        html: populatedContent,
      });

      res
        .status(200)
        .json({ success: true, message: 'Email sent successfully' });
    } catch (error) {
      console.error('Error sending template email:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
