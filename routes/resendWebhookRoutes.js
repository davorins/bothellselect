const express = require('express');
const { Resend } = require('resend');
const AiEmail = require('../models/AiEmail');

const {
  processIncomingEmail,
  shouldProcessEmail,
  resolveOriginalSender,
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
      console.error('receiving.get() error:', result.error);
      return res.status(200).json({ success: false });
    }

    const fullEmail = result.data;
    const body = fullEmail.text || fullEmail.html || '';

    // ─────────────────────────────────────────────────────────────
    // STEP 1: Resolve the REAL sender (undo ProtonMail forwarding)
    // ─────────────────────────────────────────────────────────────
    const { originalFrom, source: senderSource } = resolveOriginalSender({
      ...fullEmail,
      from,
    });

    const effectiveFrom = originalFrom || from;

    console.log('📨 Sender resolution:', {
      headerFrom: from,
      resolvedFrom: originalFrom,
      resolutionSource: senderSource,
    });

    // ─────────────────────────────────────────────────────────────
    // STEP 2: Filter — must be a registered parent
    // ─────────────────────────────────────────────────────────────
    const filter = await shouldProcessEmail({
      from: effectiveFrom,
      subject,
      body,
    });

    if (!filter.process) {
      console.log(`⏭ Ignored before AI: ${filter.reason}`);

      try {
        await AiEmail.create({
          messageId: email_id,
          threadId: null,
          from: effectiveFrom,
          originalFrom: originalFrom || null,
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
      } catch (saveErr) {
        // Duplicate messageId is fine — ignore
        if (saveErr.code !== 11000) {
          console.error('Failed to save ignored email:', saveErr.message);
        }
      }

      return res.status(200).json({
        success: true,
        ignored: true,
        reason: filter.reason,
      });
    }

    console.log('✅ Passed filter — registered parent. Calling AI...');

    // ─────────────────────────────────────────────────────────────
    // STEP 3: AI — use the resolved parent email
    // ─────────────────────────────────────────────────────────────
    const aiEmail = await processIncomingEmail({
      messageId: email_id,
      threadId: null,
      from: effectiveFrom,
      originalFrom: originalFrom || null,
      to: Array.isArray(to) ? to[0] : to,
      subject: subject || '',
      body,
      receivedAt: new Date(created_at),
    });

    console.log('✅ processIncomingEmail done. AiEmail id:', aiEmail._id);

    return res.status(200).json({
      success: true,
      aiEmailId: aiEmail._id,
    });
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(200).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
