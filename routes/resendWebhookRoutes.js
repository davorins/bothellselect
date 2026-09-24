const express = require('express');
const { Resend } = require('resend');
const mongoose = require('mongoose');
const { processIncomingEmail } = require('../services/aiEmailService');
const AiEmail = require('../models/AiEmail');

const router = express.Router();
const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/', async (req, res) => {
  console.log('\n========== 📬 RESEND WEBHOOK HIT ==========');
  console.log('Time:', new Date().toISOString());
  console.log('Mongo readyState:', mongoose.connection.readyState);
  console.log('svix-id:', req.headers['svix-id']);

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
      console.log('✅ Signature verified. Event type:', event.type);
    } catch (verifyError) {
      console.error('❌ Signature verification FAILED:', verifyError.message);
      return res
        .status(200)
        .json({ success: false, error: 'verification_failed' });
    }

    if (event.type !== 'email.received') {
      console.log('ℹ️ Ignoring event type:', event.type);
      return res.status(200).json({ status: 'ignored' });
    }

    const { email_id, from, to, subject, created_at } = event.data;
    console.log('📨 Metadata:', { email_id, from, to, subject });

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
      console.error('❌ Fetch full email failed:', fetchError.message);
      return res
        .status(200)
        .json({ success: false, error: 'fetch_body_failed' });
    }

    if (!fullEmail) {
      console.error('❌ No email data for id:', email_id);
      return res.status(200).json({ success: false, error: 'no_email_data' });
    }

    const bodyText = fullEmail.text || fullEmail.html || 'No body content';
    console.log('✅ Full email fetched. Body length:', bodyText.length);

    // ✅ AWAIT the processing so any errors surface here
    try {
      const result = await processIncomingEmail({
        messageId: email_id,
        threadId: null,
        from: from,
        to: Array.isArray(to) ? to[0] : to,
        subject: subject || '',
        body: bodyText,
        receivedAt: new Date(created_at),
      });

      console.log('✅ processIncomingEmail result:', {
        processed: result?.processed,
        duplicate: result?.duplicate,
        reason: result?.reason,
        emailId: result?.email?._id,
        status: result?.email?.status,
        confidence: result?.email?.confidence,
      });

      if (result?.email?._id) {
        const verify = await AiEmail.findById(result.email._id).lean();
        console.log('🔍 Mongo verify — doc exists:', !!verify);
      } else {
        console.warn('⚠️ No AiEmail document created. Reason:', result?.reason);
      }
    } catch (procError) {
      console.error('❌ processIncomingEmail THREW:');
      console.error('   Name:', procError.name);
      console.error('   Message:', procError.message);
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
