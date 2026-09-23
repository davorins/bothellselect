// routes/resendWebhookRoutes.js
const express = require('express');
const { processIncomingEmail } = require('../services/aiEmailService');

const router = express.Router();

// This endpoint MUST be public — Resend calls it, not your admin users.
router.post('/resend', async (req, res) => {
  const event = req.body;

  // Only care about inbound emails
  if (event.type !== 'email.received') {
    return res.status(200).json({ status: 'ignored' });
  }

  const data = event.data;

  try {
    await processIncomingEmail({
      messageId: data.message_id,
      threadId: null, // Resend webhook doesn't provide threadId here
      from: data.from,
      to: Array.isArray(data.to) ? data.to[0] : data.to,
      subject: data.subject || '',
      body: data.text || data.html || 'No body content',
      receivedAt: new Date(data.created_at),
    });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('Webhook processing error:', error);
    // Still return 200 so Resend doesn't keep retrying a bad payload
    res.status(200).json({ success: false, error: error.message });
  }
});

module.exports = router;
