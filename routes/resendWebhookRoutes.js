const express = require('express');
const { Resend } = require('resend');
const mongoose = require('mongoose');
const { processIncomingEmail } = require('../services/aiEmailService');
const AiEmail = require('../models/AiEmail');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/', async (req, res) => {
  console.log('\n========== 📬 RESEND WEBHOOK HIT ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Headers svix-id:', req.headers['svix-id']);
  console.log('Mongo readyState:', mongoose.connection.readyState);

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
      console.log('✅ Webhook signature verified');
    } catch (verifyError) {
      console.error('❌ Signature verification FAILED:', verifyError.message);
      return res
        .status(200)
        .json({ success: false, error: 'verification_failed' });
    }

    console.log('Event type:', event.type);

    if (event.type !== 'email.received') {
      console.log('ℹ️ Ignoring non-email.received event');
      return res.status(200).json({ status: 'ignored' });
    }

    const { email_id, from, to, subject, created_at } = event.data;
    console.log('📨 Email metadata:', { email_id, from, to, subject });

    let fullEmail;
    try {
      const result = await resend.emails.receiving.get(email_id);
      if (result.error) {
        console.error('❌ receiving.get() error:', result.error);
        return res
          .status(200)
          .json({ success: false, error: 'receiving_get_failed' });
      }
      fullEmail = result.data;
    } catch (fetchError) {
      console.error('❌ Failed to fetch full email:', fetchError.message);
      return res
        .status(200)
        .json({ success: false, error: 'fetch_body_failed' });
    }

    if (!fullEmail) {
      console.error('❌ No email data returned');
      return res.status(200).json({ success: false, error: 'no_email_data' });
    }

    console.log(
      '✅ Full email fetched. Body length:',
      (fullEmail.text || fullEmail.html || '').length,
    );

    // ⚠️ IMPORTANT: AWAIT here instead of fire-and-forget for diagnostics
    try {
      const aiEmail = await processIncomingEmail({
        messageId: email_id,
        threadId: null,
        from: from,
        to: Array.isArray(to) ? to[0] : to,
        subject: subject || '',
        body: fullEmail.text || fullEmail.html || 'No body content',
        receivedAt: new Date(created_at),
      });

      console.log('✅ processIncomingEmail returned:', {
        processed: aiEmail?.processed,
        duplicate: aiEmail?.duplicate,
        reason: aiEmail?.reason,
        emailId: aiEmail?.email?._id,
        status: aiEmail?.email?.status,
        confidence: aiEmail?.email?.confidence,
      });

      // Verify the document actually persisted
      if (aiEmail?.email?._id) {
        const check = await AiEmail.findById(aiEmail.email._id).lean();
        console.log('🔍 Mongo verification - document exists:', !!check);
      } else {
        console.warn(
          '⚠️ No AiEmail document was created. Reason:',
          aiEmail?.reason,
        );
      }
    } catch (procError) {
      console.error('❌❌ processIncomingEmail THREW:');
      console.error('   Message:', procError.message);
      console.error('   Name:', procError.name);
      console.error('   Stack:', procError.stack);
      if (procError.errors) {
        console.error(
          '   Validation errors:',
          JSON.stringify(procError.errors, null, 2),
        );
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Webhook outer error:', error.message);
    console.error(error.stack);
    res.status(200).json({ success: false, error: error.message });
  }
});

module.exports = router;
