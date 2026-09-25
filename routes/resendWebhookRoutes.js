const express = require('express');
const { Resend } = require('resend');
const {
  processIncomingEmail,
  shouldProcessEmail,
} = require('../services/aiEmailService');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/', async (req, res) => {
  console.log('📬 Resend webhook hit');

  try {
    // req.body is a Buffer — express.raw() is applied in index.js before this router
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
    } catch (verifyError) {
      console.error(
        '❌ Webhook signature verification failed:',
        verifyError.message,
      );
      return res
        .status(200)
        .json({ success: false, error: 'verification_failed' });
    }

    console.log('✅ Webhook verified. Event type:', event.type);

    if (event.type !== 'email.received') {
      console.log('ℹ️ Ignoring non-email.received event');
      return res.status(200).json({ status: 'ignored' });
    }

    const { email_id, from, to, subject, created_at } = event.data;
    console.log('📨 Inbound email metadata:', { email_id, from, to, subject });

    // Webhook only sends metadata — fetch the full email body
    let fullEmail;
    try {
      const result = await resend.emails.receiving.get(email_id);
      fullEmail = result.data;
      if (result.error) {
        console.error(
          '❌ Resend receiving.get() returned an error:',
          result.error,
        );
        return res
          .status(200)
          .json({ success: false, error: 'receiving_get_failed' });
      }
    } catch (fetchError) {
      console.error('❌ Failed to fetch full email body:', fetchError.message);
      return res
        .status(200)
        .json({ success: false, error: 'fetch_body_failed' });
    }

    if (!fullEmail) {
      console.error(
        '❌ receiving.get() returned no data for email_id:',
        email_id,
      );
      return res.status(200).json({ success: false, error: 'no_email_data' });
    }

    const bodyText = fullEmail.text || fullEmail.html || 'No body content';

    console.log('✅ Full email body fetched. Body length:', bodyText.length);

    // ─────────────────────────────────────────────────────────────
    // PRE-AI FILTER — only registered parents reach the AI
    // ─────────────────────────────────────────────────────────────
    const filter = await shouldProcessEmail({
      from,
      subject: subject || '',
      body: bodyText,
    });

    if (!filter.process) {
      console.log('⏭ Ignored before AI:', filter.reason);
      return res.status(200).json({
        success: true,
        ignored: true,
        reason: filter.reason,
      });
    }

    console.log(
      '✅ Passed filter — registered parent. Calling AI assistant...',
    );

    // ─────────────────────────────────────────────────────────────
    // AI PROCESSING (registered parent only)
    // ─────────────────────────────────────────────────────────────
    const aiEmail = await processIncomingEmail({
      messageId: email_id,
      threadId: null,
      from: from,
      to: Array.isArray(to) ? to[0] : to,
      subject: subject || '',
      body: bodyText,
      receivedAt: new Date(created_at),
    });

    console.log(
      '✅ processIncomingEmail completed. AiEmail id:',
      aiEmail._id,
      'status:',
      aiEmail.status,
    );

    return res.status(200).json({
      success: true,
      aiEmailId: aiEmail._id,
    });
  } catch (error) {
    console.error('❌ Resend webhook error:', error.message);
    console.error(error.stack);
    // Return 200 so Resend doesn't endlessly retry a malformed payload
    res.status(200).json({ success: false, error: error.message });
  }
});

module.exports = router;
