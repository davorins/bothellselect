const express = require('express');
const { Resend } = require('resend');
const AiEmail = require('../models/AiEmail');

const {
  processIncomingEmail,
  shouldProcessEmail,
} = require('../services/aiEmailService');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/', async (req, res) => {
  console.log('📬 Resend webhook hit');

  try {
    const payload = req.body.toString('utf8');

    let event;

    try {
      event = resend.webhooks.verify({
        payload,
        headers: {
          id: req.headers['svix-id'],
          timestamp: req.headers['svix-timestamp'],
          signature: req.headers['svix-signature'],
        },
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
      });
    } catch (err) {
      console.error('Webhook verification failed:', err.message);
      return res.status(200).json({ success: false });
    }

    if (event.type !== 'email.received') {
      return res.status(200).json({ ignored: true });
    }

    const { email_id, from, to, subject, created_at } = event.data;

    const result = await resend.emails.receiving.get(email_id);

    if (result.error || !result.data) {
      console.error(result.error);
      return res.status(200).json({ success: false });
    }

    const fullEmail = result.data;

    const body = fullEmail.text || fullEmail.html || '';

    // --------------------------------------------------
    // FILTER BEFORE AI
    // --------------------------------------------------

    const filter = await shouldProcessEmail({
      from,
      subject,
      body,
    });

    if (!filter.process) {
      console.log(`Ignored: ${filter.reason}`);

      await AiEmail.create({
        messageId: email_id,
        threadId: null,
        from,
        to: Array.isArray(to) ? to[0] : to,
        subject: subject || '',
        body,
        receivedAt: new Date(created_at),
        status: 'ignored',
        category: 'other',
        confidence: 0,
        requiresHumanReview: false,
        reviewReason: filter.reason,
      });

      return res.status(200).json({
        success: true,
        ignored: true,
      });
    }

    // --------------------------------------------------
    // AI
    // --------------------------------------------------

    const aiEmail = await processIncomingEmail({
      messageId: email_id,
      threadId: null,
      from,
      to: Array.isArray(to) ? to[0] : to,
      subject: subject || '',
      body,
      receivedAt: new Date(created_at),
    });

    return res.status(200).json({
      success: true,
      aiEmailId: aiEmail._id,
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
