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

// Helper function to get the complete HTML content for a template
const getCompleteEmailHTML = async (template, variables = {}) => {
  try {
    // First, try to use the completeContent from the template
    let emailHtml = template.completeContent;

    // If completeContent doesn't exist or is empty, generate it
    if (!emailHtml || emailHtml.trim() === '') {
      console.log(`Generating complete HTML for template: ${template.title}`);
      emailHtml = template.getCompleteEmailHTML();

      // Save it for future use
      template.completeContent = emailHtml;
      await template.save();
    }

    // Replace variables in the complete HTML
    if (variables) {
      const flattenedVariables = flattenVariables(variables);
      for (const [key, value] of Object.entries(flattenedVariables)) {
        const variableKey = `[${key}]`;
        const regex = new RegExp(
          variableKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          'g'
        );
        emailHtml = emailHtml.replace(regex, value || '');
      }
    }

    return emailHtml;
  } catch (error) {
    console.error('Error getting complete email HTML:', error);
    // Fallback to raw content if something goes wrong
    return template.content;
  }
};

// Helper to flatten nested variables
const flattenVariables = (obj, prefix = '', res = {}) => {
  for (const key in obj) {
    if (obj.hasOwnProperty(key)) {
      const prefixedKey = prefix ? `${prefix}.${key}` : key;
      if (
        typeof obj[key] === 'object' &&
        obj[key] !== null &&
        !Array.isArray(obj[key])
      ) {
        flattenVariables(obj[key], prefixedKey, res);
      } else {
        res[prefixedKey] = obj[key];
      }
    }
  }
  return res;
};

// Helper function to send bulk emails
const sendBulkEmails = async ({
  template,
  subject,
  recipients,
  variables = {},
}) => {
  const results = await Promise.allSettled(
    recipients.map(async (recipient) => {
      try {
        let personalizedHtml = template;

        // Replace recipient-specific variables
        if (recipient.email) {
          personalizedHtml = personalizedHtml.replace(
            /\[email\]/g,
            recipient.email
          );
        }
        if (recipient.fullName) {
          personalizedHtml = personalizedHtml.replace(
            /\[fullName\]/g,
            recipient.fullName
          );
          personalizedHtml = personalizedHtml.replace(
            /\[parent\.fullName\]/g,
            recipient.fullName
          );
        }
        if (recipient._id) {
          personalizedHtml = personalizedHtml.replace(
            /\[parentId\]/g,
            recipient._id.toString()
          );
        }

        await sendEmail({
          to: recipient.email,
          subject: subject,
          html: personalizedHtml,
          // Also include text version for email clients
          text: htmlToText(personalizedHtml),
        });

        return { success: true, email: recipient.email };
      } catch (err) {
        return { success: false, email: recipient.email, error: err.message };
      }
    })
  );

  const formattedResults = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { success: false, error: r.reason }
  );

  return {
    successCount: formattedResults.filter((r) => r.success).length,
    failedCount: formattedResults.filter((r) => !r.success).length,
    results: formattedResults,
  };
};

// Helper to convert HTML to plain text
const htmlToText = (html) => {
  return html
    .replace(/<[^>]*>/g, ' ') // Remove HTML tags
    .replace(/\s+/g, ' ') // Collapse multiple spaces
    .trim();
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

      // Get the complete email HTML
      const baseEmailHtml = await getCompleteEmailHTML(template, {
        season: season || '',
        year: year || '',
      });

      const results = await Promise.allSettled(
        recipients.map(async (parent) => {
          try {
            const player = await Player.findOne({ parentId: parent._id });

            // Get personalized HTML for this recipient
            let personalizedHtml = baseEmailHtml;

            // Replace parent variables
            personalizedHtml = personalizedHtml.replace(
              /\[parent\.fullName\]/g,
              parent.fullName || ''
            );
            personalizedHtml = personalizedHtml.replace(
              /\[parent\.email\]/g,
              parent.email || ''
            );
            personalizedHtml = personalizedHtml.replace(
              /\[parent\.phone\]/g,
              parent.phone || ''
            );

            // Replace player variables if player exists
            if (player) {
              personalizedHtml = personalizedHtml.replace(
                /\[player\.fullName\]/g,
                player.fullName || ''
              );
              personalizedHtml = personalizedHtml.replace(
                /\[player\.firstName\]/g,
                player.firstName || ''
              );
              personalizedHtml = personalizedHtml.replace(
                /\[player\.grade\]/g,
                player.grade || ''
              );
              personalizedHtml = personalizedHtml.replace(
                /\[player\.schoolName\]/g,
                player.schoolName || ''
              );
            }

            // Replace season/year variables
            if (season) {
              personalizedHtml = personalizedHtml.replace(
                /\[season\]/g,
                season
              );
            }
            if (year) {
              personalizedHtml = personalizedHtml.replace(/\[year\]/g, year);
            }

            await sendEmail({
              to: parent.email,
              subject: template.subject,
              html: personalizedHtml,
              text: htmlToText(personalizedHtml),
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

router.post(
  '/send-manual',
  authenticate,
  authorizeAdmin,
  [
    body('templateId').notEmpty().withMessage('Template ID is required'),
    body('emails')
      .isArray({ min: 1 })
      .withMessage('Emails must be a non-empty array'),
    body('emails.*').isEmail().withMessage('Each email must be valid'),
    body('variables')
      .optional()
      .isObject()
      .withMessage('Variables must be an object'),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    const { templateId, emails, variables = {} } = req.body;

    try {
      const template = await EmailTemplate.findById(templateId);
      if (!template) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }

      // Get the complete email HTML with variables
      const emailHtml = await getCompleteEmailHTML(template, {
        parent: {
          fullName: variables.parent?.fullName || 'Valued Member',
          email: emails.join(', '),
        },
        isManual: true,
        ...variables,
      });

      // Create recipient objects for bulk sending
      const recipients = emails.map((email) => ({ email }));

      const { successCount, failedCount, results } = await sendBulkEmails({
        template: emailHtml,
        subject: template.subject,
        recipients: recipients,
        variables: variables,
      });

      res.json({
        success: true,
        totalRecipients: emails.length,
        successfulSends: successCount,
        failedSends: failedCount,
        results,
      });
    } catch (error) {
      console.error('Manual email send error:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to send manual emails',
        details: error.message,
      });
    }
  }
);

// New route to preview complete email HTML
router.post(
  '/preview-complete',
  authenticate,
  authorizeAdmin,
  [
    body('templateId').notEmpty().withMessage('Template ID is required'),
    body('variables')
      .optional()
      .isObject()
      .withMessage('Variables must be an object'),
  ],
  async (req, res) => {
    try {
      const { templateId, variables = {} } = req.body;

      const template = await EmailTemplate.findById(templateId);
      if (!template) {
        return res
          .status(404)
          .json({ success: false, error: 'Template not found' });
      }

      const completeHtml = await getCompleteEmailHTML(template, variables);

      res.json({
        success: true,
        data: {
          html: completeHtml,
          subject: template.subject,
          title: template.title,
          hasCompleteContent: !!template.completeContent,
        },
      });
    } catch (error) {
      console.error('Error previewing complete email:', error);
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

module.exports = router;
