const express = require('express');
const { Resend } = require('resend');
const { processIncomingEmail } = require('../services/aiEmailService');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

router.post(
  '/resend',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      const payload = req.body.toString('utf8');

      // Verify signature (recommended for production)
      const event = resend.webhooks.verify({
        payload,
        headers: {
          id: req.headers['svix-id'],
          timestamp: req.headers['svix-timestamp'],
          signature: req.headers['svix-signature'],
        },
        webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
      });

      if (event.type !== 'email.received') {
        return res.status(200).json({ status: 'ignored' });
      }

      const { email_id, from, to, subject, created_at } = event.data;

      // ⚠️ CRITICAL: Fetch the FULL email content (body is NOT in the webhook)
      const { data: fullEmail, error } =
        await resend.emails.receiving.get(email_id);

      if (error || !fullEmail) {
        console.error('Failed to fetch email body:', error);
        return res.status(200).json({ success: false });
      }

      await processIncomingEmail({
        messageId: email_id,
        threadId: null,
        from: from,
        to: Array.isArray(to) ? to[0] : to,
        subject: subject || '',
        body: fullEmail.text || fullEmail.html || 'No body content',
        receivedAt: new Date(created_at),
      });

      res.status(200).json({ success: true });
    } catch (error) {
      console.error('Resend webhook error:', error.message);
      // Return 200 so Resend doesn't endlessly retry a malformed payload
      res.status(200).json({ success: false, error: error.message });
    }
  },
);

module.exports = router;
