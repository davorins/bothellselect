const express = require('express');
const { authenticate, isAdmin } = require('../utils/auth');

const {
  processIncomingEmail,
  getPendingAiEmails,
  getAllAiEmails,
  getAiEmailById,
  manualSendAiEmail,
  getAiSettings,
  updateAiSettings,
} = require('../services/aiEmailService');

const router = express.Router();

// ── Settings (place BEFORE the /:id route to avoid conflicts) ──

router.get('/settings', authenticate, isAdmin, async (req, res) => {
  try {
    const settings = await getAiSettings();
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error loading AI settings:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to load AI settings.' });
  }
});

router.patch('/settings', authenticate, isAdmin, async (req, res) => {
  try {
    const updatedBy = req.user && req.user.id ? req.user.id : null;
    const settings = await updateAiSettings(req.body, updatedBy);
    res.json({ success: true, settings });
  } catch (error) {
    console.error('Error updating AI settings:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to update AI settings.' });
  }
});

// ── List / fetch ──

router.get('/', authenticate, isAdmin, async (req, res) => {
  try {
    const { status, limit } = req.query;
    const emails = status
      ? await getAllAiEmails({ status, limit: Number(limit) || 100 })
      : await getPendingAiEmails();
    res.json({ success: true, emails });
  } catch (error) {
    console.error('Error loading AI emails:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to load AI emails.' });
  }
});

router.get('/:id', authenticate, isAdmin, async (req, res) => {
  try {
    const email = await getAiEmailById(req.params.id);
    if (!email) {
      return res
        .status(404)
        .json({ success: false, message: 'AI email not found.' });
    }
    res.json({ success: true, email });
  } catch (error) {
    console.error('Error loading AI email:', error);
    res
      .status(500)
      .json({ success: false, message: 'Failed to load AI email.' });
  }
});

// ── Manual send ──

router.post('/:id/send', authenticate, isAdmin, async (req, res) => {
  try {
    const aiEmail = await getAiEmailById(req.params.id);
    if (!aiEmail) {
      return res
        .status(404)
        .json({ success: false, message: 'AI email not found.' });
    }

    const reviewedBy = req.user && req.user.id ? req.user.id : null;
    const updated = await manualSendAiEmail(aiEmail, {
      draft: req.body && req.body.draft,
      reviewedBy,
    });

    res.json({ success: true, email: updated });
  } catch (error) {
    console.error('Manual send error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Reject a draft ──

router.post('/:id/reject', authenticate, isAdmin, async (req, res) => {
  try {
    const aiEmail = await getAiEmailById(req.params.id);
    if (!aiEmail) {
      return res
        .status(404)
        .json({ success: false, message: 'AI email not found.' });
    }
    aiEmail.status = 'rejected';
    aiEmail.requiresHumanReview = false;
    aiEmail.reviewReason =
      (req.body && req.body.reason) || 'Rejected by administrator.';
    if (req.user && req.user.id) {
      aiEmail.reviewedBy = req.user.id;
      aiEmail.reviewedAt = new Date();
    }
    await aiEmail.save();
    res.json({ success: true, email: aiEmail });
  } catch (error) {
    console.error('Reject error:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ── Test endpoints (kept from before) ──

router.post('/test', authenticate, isAdmin, async (req, res) => {
  try {
    const { messageId, from, to, subject, body, threadId, receivedAt } =
      req.body;

    if (!from) {
      return res
        .status(400)
        .json({ success: false, message: 'from is required.' });
    }
    if (!body) {
      return res
        .status(400)
        .json({ success: false, message: 'body is required.' });
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

    res.status(201).json({ success: true, email });
  } catch (error) {
    console.error('Error processing AI email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to process email through AI assistant.',
      error: error.message,
    });
  }
});

router.post('/ingest-test', authenticate, isAdmin, async (req, res) => {
  try {
    const { messageId, threadId, from, to, subject, body, receivedAt } =
      req.body;

    if (!from) {
      return res
        .status(400)
        .json({ success: false, message: 'from is required.' });
    }
    if (!body) {
      return res
        .status(400)
        .json({ success: false, message: 'body is required.' });
    }

    const email = await processIncomingEmail({
      messageId:
        messageId ||
        `ingest-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      threadId: threadId || null,
      from,
      to: to || 'bothellselect@proton.me',
      subject: subject || '',
      body,
      receivedAt: receivedAt || new Date(),
    });

    res.status(201).json({ success: true, email });
  } catch (error) {
    console.error('Error ingesting test email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to ingest test email.',
      error: error.message,
    });
  }
});

module.exports = router;
