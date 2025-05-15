const express = require('express');
const { body, validationResult } = require('express-validator');
const { authenticate } = require('../utils/auth');
const EmailTemplate = require('../models/EmailTemplate');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const { replaceTemplateVariables } = require('../utils/templateHelpers');
const { sendEmail } = require('../utils/email');

const router = express.Router();

// 🔐 Middleware for admin-only routes
const authorizeAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Access denied' });
  }
  next();
};

router.post(
  '/send-campaign',
  authenticate,
  authorizeAdmin,
  [
    body('templateId').notEmpty().withMessage('Template ID is required'),
    body('parentIds')
      .optional()
      .isArray()
      .withMessage('Parent IDs must be an array'),
    body('season').optional().isString(),
    body('year').optional().isInt(),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { templateId, parentIds = [], season, year } = req.body;

    try {
      const template = await EmailTemplate.findById(templateId);
      if (!template) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }

      let recipients = [];
      if (season && year) {
        const players = await Player.find({ season, registrationYear: year });
        const uniqueParentIds = [
          ...new Set(players.map((p) => p.parentId?.toString())),
        ];
        recipients = await Parent.find({ _id: { $in: uniqueParentIds } });
      } else if (parentIds.length > 0) {
        recipients = await Parent.find({ _id: { $in: parentIds } });
      } else {
        return res.status(400).json({
          success: false,
          error: 'Must provide either parentIds or season/year',
        });
      }

      const results = await Promise.allSettled(
        recipients.map(async (parent) => {
          try {
            const player = await Player.findOne({ parentId: parent._id });

            const populatedContent = await replaceTemplateVariables(
              template.content,
              {
                parentId: parent._id,
                playerId: player?._id,
              }
            );

            await sendEmail({
              to: parent.email,
              subject: template.subject,
              html: populatedContent,
            });

            return {
              success: true,
              parentId: parent._id,
              email: parent.email,
            };
          } catch (err) {
            return {
              success: false,
              parentId: parent._id,
              email: parent.email,
              error: err.message,
            };
          }
        })
      );

      const formattedResults = results.map((r) =>
        r.status === 'fulfilled' ? r.value : { success: false, error: r.reason }
      );

      res.json({
        success: true,
        totalRecipients: recipients.length,
        successfulSends: formattedResults.filter((r) => r.success).length,
        failedSends: formattedResults.filter((r) => !r.success).length,
        results: formattedResults,
      });
    } catch (error) {
      console.error('Error sending campaign:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send campaign',
        details: error.message,
      });
    }
  }
);

module.exports = router;
