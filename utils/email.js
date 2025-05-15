const { Resend } = require('resend');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const EmailTemplate = require('../models/EmailTemplate');

const resend = new Resend(process.env.RESEND_API_KEY);

// Replace template variables using parent and player IDs
async function replaceTemplateVariables(
  templateContent,
  { parentId, playerId }
) {
  let parent = null;
  let player = null;

  if (parentId) {
    parent = await Parent.findById(parentId).lean();
  }

  if (playerId) {
    player = await Player.findById(playerId).lean();
    if (player?.fullName) {
      player.firstName = player.fullName.split(' ')[0];
    }
  }

  if (parent) {
    templateContent = templateContent.replace(
      /\[parent\.fullName\]/g,
      parent.fullName || ''
    );
    templateContent = templateContent.replace(
      /\[parent\.email\]/g,
      parent.email || ''
    );
    templateContent = templateContent.replace(
      /\[parent\.phone\]/g,
      parent.phone || ''
    );
  }

  if (player) {
    templateContent = templateContent.replace(
      /\[player\.fullName\]/g,
      player.fullName || ''
    );
    templateContent = templateContent.replace(
      /\[player\.firstName\]/g,
      player.firstName || ''
    );
    templateContent = templateContent.replace(
      /\[player\.grade\]/g,
      player.grade || ''
    );
    templateContent = templateContent.replace(
      /\[player\.schoolName\]/g,
      player.schoolName || ''
    );
  }

  return templateContent;
}

// General email sender
async function sendEmail({ to, subject, html, parentId, playerId }) {
  try {
    let finalHtml = html;

    // Only replace template variables if html is not already populated
    if (
      ((parentId || playerId) && html.includes('[parent.')) ||
      html.includes('[player.')
    ) {
      finalHtml = await replaceTemplateVariables(html, { parentId, playerId });
    }

    const { data, error } = await resend.emails.send({
      from: 'Bothell Select <info@bothellselect.com>',
      to,
      subject,
      html: finalHtml,
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

// sendWelcomeEmail function
async function sendWelcomeEmail(parentId, playerId) {
  try {
    // 1. Find the "Welcome" template from your database
    const template = await EmailTemplate.findOne({ title: 'Welcome' });

    if (!template) {
      throw new Error('Welcome email template not found in database');
    }

    // 2. Get the parent and player data
    const parent = await Parent.findById(parentId);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    const player = await Player.findById(playerId);
    if (!player) {
      throw new Error(`Player not found with ID: ${playerId}`);
    }

    // 3. Replace template variables
    const populatedContent = await replaceTemplateVariables(template.content, {
      parentId,
      playerId,
    });

    // 4. Send the email
    const result = await sendEmail({
      to: parent.email,
      subject: template.subject,
      html: populatedContent,
      parentId,
      playerId,
    });

    console.log('Welcome email sent successfully using template:', result);
    return result;
  } catch (err) {
    console.error('Error in sendWelcomeEmail:', {
      error: err,
      parentId,
      playerId,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// Send password reset email using Resend
async function sendResetEmail(email, resetToken) {
  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  const html = `
    <p>You requested a password reset for your account.</p>
    <p>Click this link to reset your password:</p>
    <a href="${resetUrl}">${resetUrl}</a>
    <p>This link will expire in 1 hour.</p>
    <p>If you didn't request this, please ignore this email.</p>
  `;

  try {
    const { data, error } = await resend.emails.send({
      from: 'Bothell Select <info@bothellselect.com>',
      to: email,
      subject: 'Password Reset Request',
      html,
    });

    if (error) {
      console.error('Resend email error:', error);
      throw new Error(`Failed to send reset email: ${error.message || error}`);
    }

    console.log(`Reset email sent to ${email}`);
    return data;
  } catch (error) {
    console.error('Error sending reset email:', error);
    throw new Error('Failed to send reset email');
  }
}

module.exports = {
  sendEmail,
  sendResetEmail,
  sendWelcomeEmail,
};
