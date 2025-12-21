const express = require('express');
const { body, validationResult } = require('express-validator');
const router = express.Router();

const EmailTemplate = require('../models/EmailTemplate');

const { authenticate } = require('../utils/auth');

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
      // If frontend sends completeContent, use it; otherwise it will be auto-generated
      const templateData = {
        ...req.body,
        createdBy: req.user.id,
        lastUpdatedBy: req.user.id,
      };

      // Make sure we don't have duplicate completeContent field if frontend sent it
      // Let the model's pre-save middleware generate it
      if (templateData.completeContent) {
        delete templateData.completeContent;
      }

      const template = new EmailTemplate(templateData);
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
    res.json({
      success: true,
      data: templates,
    });
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

    // Ensure template has completeContent
    if (!template.completeContent) {
      template.completeContent = template.getCompleteEmailHTML();
      await template.save();
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

      // Set lastUpdatedBy
      req.body.lastUpdatedBy = req.user.id;

      // Remove completeContent if frontend sent it - let model generate fresh one
      if (req.body.completeContent) {
        delete req.body.completeContent;
      }

      // Only update allowed fields
      const updates = Object.keys(req.body);
      updates.forEach((update) => {
        template[update] = req.body[update];
      });

      await template.save();

      // Ensure template has completeContent
      if (!template.completeContent) {
        template.completeContent = template.getCompleteEmailHTML();
        await template.save();
      }

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

// ✅ Generate complete HTML for a template (for testing)
router.get('/:id/generate-html', authenticate, async (req, res) => {
  try {
    const template = await EmailTemplate.findById(req.params.id);
    if (!template) {
      return res
        .status(404)
        .json({ success: false, error: 'Template not found' });
    }

    const completeHTML = template.getCompleteEmailHTML();

    res.json({
      success: true,
      data: {
        html: completeHTML,
        hasCompleteContent: !!template.completeContent,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
