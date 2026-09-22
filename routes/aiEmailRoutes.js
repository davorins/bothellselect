const express = require('express');

const { authenticate, isAdmin } = require('../utils/auth');

const {
  processIncomingEmail,
  getPendingAiEmails,
  getAiEmailById,
} = require('../services/aiEmailService');

const router = express.Router();

/**
 * Get AI emails waiting for administrative action.
 *
 * GET /api/admin/ai-emails
 */
router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const emails = await getPendingAiEmails();

    res.json({
      success: true,
      emails,
    });
  } catch (error) {
    console.error('Error loading AI emails:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to load AI emails.',
    });
  }
});

/**
 * Get one AI email.
 *
 * GET /api/admin/ai-emails/:id
 */
router.get('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const email = await getAiEmailById(req.params.id);

    if (!email) {
      return res.status(404).json({
        success: false,
        message: 'AI email not found.',
      });
    }

    res.json({
      success: true,
      email,
    });
  } catch (error) {
    console.error('Error loading AI email:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to load AI email.',
    });
  }
});

/**
 * TEST endpoint:
 * Process an incoming email through the AI assistant.
 *
 * POST /api/admin/ai-emails/test
 *
 * This does NOT send an email.
 */
router.post('/test', authenticate, isAdmin, async (req, res) => {
  try {
    const { messageId, from, to, subject, body, threadId, receivedAt } =
      req.body;

    if (!from) {
      return res.status(400).json({
        success: false,
        message: 'from is required.',
      });
    }

    if (!body) {
      return res.status(400).json({
        success: false,
        message: 'body is required.',
      });
    }

    const email = await processIncomingEmail({
      messageId:
        messageId ||
        `test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,

      threadId: threadId || null,
      from,
      to: to || 'info@bothellselect.com',
      subject: subject || '',
      body,
      receivedAt: receivedAt || new Date(),
    });

    res.status(201).json({
      success: true,
      email,
    });
  } catch (error) {
    console.error('Error processing AI email:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to process email through AI assistant.',
      error: error.message,
    });
  }
});

module.exports = router;
