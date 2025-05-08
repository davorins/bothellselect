// utils/email.js
const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendEmail({ to, subject, html }) {
  try {
    const { data, error } = await resend.emails.send({
      from: 'Bothell Select <info@bothellselect.com>',
      to,
      subject,
      html,
    });

    if (error) {
      console.error('Email error:', error);
      throw error;
    }

    return data;
  } catch (err) {
    console.error('Email sending failed:', err);
    throw err;
  }
}

module.exports = { sendEmail };
