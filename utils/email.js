const { Resend } = require('resend');
const Parent = require('../models/Parent');
const Player = require('../models/Player');
const Team = require('../models/Team');
const EmailTemplate = require('../models/EmailTemplate');

const resend = new Resend(process.env.RESEND_API_KEY);

// ============ TEMPLATE VARIABLE REPLACEMENT ============
async function replaceTemplateVariables(
  templateContent,
  { parentId, playerId, teamId, tournamentData }
) {
  let parent = null;
  let player = null;
  let team = null;

  if (parentId) {
    parent = await Parent.findById(parentId).lean();
  }

  if (playerId) {
    player = await Player.findById(playerId).lean();
    if (player?.fullName) {
      player.firstName = player.fullName.split(' ')[0];
    }
  }

  if (teamId) {
    team = await Team.findById(teamId).lean();
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

  if (team) {
    templateContent = templateContent.replace(
      /\[team\.name\]/g,
      team.name || ''
    );
    templateContent = templateContent.replace(
      /\[team\.grade\]/g,
      team.grade || ''
    );
    templateContent = templateContent.replace(/\[team\.sex\]/g, team.sex || '');
    templateContent = templateContent.replace(
      /\[team\.levelOfCompetition\]/g,
      team.levelOfCompetition || ''
    );
  }

  // Add tournament data if provided
  if (tournamentData) {
    templateContent = templateContent.replace(
      /\[tournament\.name\]/g,
      tournamentData.tournament || ''
    );
    templateContent = templateContent.replace(
      /\[tournament\.year\]/g,
      tournamentData.year || ''
    );
    templateContent = templateContent.replace(
      /\[tournament\.fee\]/g,
      tournamentData.fee || '$425'
    );
  }

  return templateContent;
}

// ============ GENERAL EMAIL SENDER ============
async function sendEmail({
  to,
  subject,
  html,
  parentId,
  playerId,
  teamId,
  tournamentData,
}) {
  try {
    let finalHtml = html;

    // Only replace template variables if html contains template markers
    if (
      html.includes('[parent.') ||
      html.includes('[player.') ||
      html.includes('[team.') ||
      html.includes('[tournament.')
    ) {
      finalHtml = await replaceTemplateVariables(html, {
        parentId,
        playerId,
        teamId,
        tournamentData,
      });
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

// ============ PLAYER/TROUT WELCOME EMAIL ============
// This is ONLY for player/tryout registrations
async function sendWelcomeEmail(parentId, playerId) {
  try {
    // 1. Find the "Welcome" template from your database
    const template = await EmailTemplate.findOne({ title: 'Welcome' });

    if (!template) {
      console.warn('Welcome email template not found, using default template');
      // Use a default template if database template not found
      const defaultTemplate = {
        subject: 'Welcome to Bothell Select Basketball!',
        content: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
            <div style="text-align: center; margin-bottom: 20px;">
              <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
            </div>
            
            <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
              <h1 style="margin: 0;">Welcome to Bothell Select Basketball!</h1>
            </div>
            
            <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
              <p style="font-size: 16px;">Dear [parent.fullName],</p>
              
              <p style="font-size: 16px;">Welcome to the Bothell Select Basketball family! We're excited to have [player.firstName] join our program.</p>
              
              <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
                <h3 style="margin-top: 0; color: #506ee4;">Registration Confirmed</h3>
                <p style="margin: 8px 0;"><strong>Player:</strong> [player.fullName]</p>
              </div>
              
              <p style="font-size: 16px;"><strong>What's Next?</strong></p>
              <ul style="font-size: 14px;">
                <li>Complete payment for tryouts/season registration</li>
                <li>You will receive tryout schedule and team assignment information</li>
                <li>Look out for welcome materials from your coach</li>
                <li>Practice schedules will be shared via email and the team portal</li>
              </ul>
              
              <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
              
              <p style="font-size: 16px; font-weight: bold;">Welcome to the Bothell Select family! 🏀</p>
            </div>
          </div>
        `,
      };
      return sendEmail({
        to: parent.email,
        subject: defaultTemplate.subject,
        html: defaultTemplate.content,
        parentId,
        playerId,
      });
    }

    // 2. Get the parent and player data - BOTH ARE REQUIRED FOR THIS FUNCTION
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

    console.log('Welcome email sent successfully for player registration:', {
      parentId,
      playerId,
      playerName: player.fullName,
      email: parent.email,
    });
    return result;
  } catch (err) {
    console.error('Error in sendWelcomeEmail:', {
      error: err.message,
      parentId,
      playerId,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ TOURNAMENT WELCOME EMAIL ============
// This is ONLY for tournament registrations (teams, not players)
async function sendTournamentWelcomeEmail(parentId, teamId, tournament, year) {
  try {
    console.log('Sending tournament welcome email:', {
      parentId,
      teamId,
      tournament,
      year,
    });

    // 1. Get the parent and team data
    const parent = await Parent.findById(parentId);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    let team = null;
    if (teamId) {
      team = await Team.findById(teamId).lean();
      if (!team) {
        console.warn(
          `Team not found with ID: ${teamId}, continuing without team details`
        );
      }
    }

    // 2. Build the tournament welcome email
    const subject = `Tournament Registration Received - ${tournament} ${year}`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
        </div>
        
        <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">🏀 Tournament Registration Received!</h1>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
          <p style="font-size: 16px;">Dear ${parent.fullName || 'Coach'},</p>
          
          <p style="font-size: 16px;">Thank you for registering for the ${tournament} ${year} tournament!</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
            <h3 style="margin-top: 0; color: #506ee4;">Registration Details</h3>
            ${team ? `<p style="margin: 8px 0;"><strong>Team:</strong> ${team.name}</p>` : ''}
            <p style="margin: 8px 0;"><strong>Tournament:</strong> ${tournament} ${year}</p>
            <p style="margin: 8px 0;"><strong>Registration Fee:</strong> $425 per team</p>
          </div>
          
          <p style="font-size: 16px;"><strong>Next Steps:</strong></p>
          <ul style="font-size: 14px;">
            <li>Complete your payment to secure your team's spot in the tournament</li>
            <li>You will receive tournament schedule and bracket information via email</li>
            <li>Check the tournament website for updates and rules</li>
            <li>Ensure all player waivers and forms are completed</li>
          </ul>
          
          <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107;">
            <h4 style="margin-top: 0; color: #856404;">⚠️ Important:</h4>
            <p style="margin: 8px 0; color: #856404;">Your tournament registration is <strong>not complete</strong> until payment is received. Please complete payment as soon as possible to secure your team's spot.</p>
          </div>
          
          <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
          
          <p style="font-size: 16px; font-weight: bold;">We look forward to seeing you at the tournament! 🏀</p>
        </div>
        
        <div style="background: #e5e7eb; padding: 15px; text-align: center; font-size: 14px; color: #555; border-radius: 0 0 5px 5px;">
          <p style="margin: 0;">Bothell Select Basketball<br>
          bothellselect@proton.me</p>
        </div>
      </div>
    `;

    // 3. Send the email
    const result = await sendEmail({
      to: parent.email,
      subject,
      html: emailHtml,
      parentId,
      teamId,
      tournamentData: {
        tournament,
        year,
        fee: '$425',
      },
    });

    console.log('Tournament welcome email sent successfully:', {
      parentId,
      teamId,
      tournament,
      year,
      email: parent.email,
    });
    return result;
  } catch (err) {
    console.error('Error in sendTournamentWelcomeEmail:', {
      error: err.message,
      parentId,
      teamId,
      tournament,
      year,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ TOURNAMENT REGISTRATION EMAIL (AFTER PAYMENT) ============
// This is sent after successful payment for tournament registration
async function sendTournamentRegistrationEmail(
  parentId,
  teamIds,
  tournament,
  year,
  totalAmount
) {
  try {
    // 1. Get the parent data
    const parent = await Parent.findById(parentId);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    // 2. Get teams data
    const teams = await Team.find({ _id: { $in: teamIds } }).lean();
    const teamCount = teams.length;

    // 3. Build teams information HTML
    let teamsInfoHtml = '';
    if (teams.length > 0) {
      teams.forEach((team, index) => {
        teamsInfoHtml += `
          <div style="background: #f0f4f8; padding: 10px; border-radius: 4px; margin: 10px 0;">
            <h5 style="margin: 0;">Team ${index + 1}: ${team.name}</h5>
            <p style="margin: 5px 0;"><strong>Grade:</strong> ${team.grade}</p>
            <p style="margin: 5px 0;"><strong>Gender:</strong> ${team.sex}</p>
            <p style="margin: 5px 0;"><strong>Level:</strong> ${team.levelOfCompetition || 'Silver'}</p>
          </div>
        `;
      });
    }

    // 4. Create the confirmation email
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
        </div>
        
        <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">🎉 Tournament Registration Confirmed!</h1>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
          <p style="font-size: 16px;">Dear ${parent.fullName || 'Coach'},</p>
          
          <p style="font-size: 16px;">Thank you for your payment! Your tournament registration for ${teamCount} team(s) has been confirmed.</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
            <h3 style="margin-top: 0; color: #506ee4;">Payment & Registration Details</h3>
            <p style="margin: 8px 0;"><strong>Number of Teams:</strong> ${teamCount}</p>
            <p style="margin: 8px 0;"><strong>Tournament:</strong> ${tournament} ${year}</p>
            <p style="margin: 8px 0;"><strong>Total Amount Paid:</strong> $${totalAmount}</p>
            <p style="margin: 8px 0;"><strong>Fee per Team:</strong> $${teamCount > 0 ? (totalAmount / teamCount).toFixed(2) : '425'}</p>
          </div>
          
          ${
            teams.length > 0
              ? `
          <div style="margin: 20px 0;">
            <h4 style="color: #506ee4;">Team Details:</h4>
            ${teamsInfoHtml}
          </div>
          `
              : ''
          }
          
          <p style="font-size: 16px;"><strong>What's Next?</strong></p>
          <ul style="font-size: 14px;">
            <li>You will receive tournament schedule and bracket information via email 1-2 weeks before the tournament</li>
            <li>Check the tournament website for updates, rules, and venue information</li>
            <li>Ensure all player waivers and medical forms are completed and submitted</li>
            <li>Each team will be scheduled separately based on their division and skill level</li>
          </ul>
          
          <div style="background: #d1e7dd; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #0f5132;">
            <h4 style="margin-top: 0; color: #0f5132;">✅ Registration Complete!</h4>
            <p style="margin: 8px 0; color: #0f5132;">Your team(s) are officially registered for the tournament. We'll be in touch soon with more details.</p>
          </div>
          
          <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
          
          <p style="font-size: 16px; font-weight: bold;">Good luck in the tournament! 🏀</p>
        </div>
        
        <div style="background: #e5e7eb; padding: 15px; text-align: center; font-size: 14px; color: #555; border-radius: 0 0 5px 5px;">
          <p style="margin: 0;">Bothell Select Basketball<br>
          bothellselect@proton.me</p>
        </div>
      </div>
    `;

    // 5. Send the email
    const result = await sendEmail({
      to: parent.email,
      subject: `Tournament Registration Confirmation - ${tournament} ${year}`,
      html: emailHtml,
      parentId,
      tournamentData: {
        tournament,
        year,
        fee: '$425',
      },
    });

    console.log('Tournament registration email sent successfully:', {
      parentId,
      teamCount,
      tournament,
      year,
      totalAmount,
      email: parent.email,
    });

    return result;
  } catch (err) {
    console.error('Error in sendTournamentRegistrationEmail:', {
      error: err.message,
      parentId,
      teamIds,
      tournament,
      year,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ TRYOUT EMAIL ============
async function sendTryoutEmail(parentId, playerId) {
  try {
    // 1. Find the "Welcome Tryout" template from your database
    const template = await EmailTemplate.findOne({ title: 'Welcome Tryout' });

    if (!template) {
      throw new Error('Welcome Tryout email template not found in database');
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

    console.log(
      'Welcome Tryout email sent successfully using template:',
      result
    );
    return result;
  } catch (err) {
    console.error('Error in sendTryoutEmail:', {
      error: err,
      parentId,
      playerId,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ PAYMENT CONFIRMATION EMAIL ============
async function sendPaymentConfirmationEmail(
  parentId,
  playerIds,
  totalAmount,
  season,
  year
) {
  try {
    // 1. Find the payment confirmation template
    const template = await EmailTemplate.findOne({
      title: 'Payment Confirmation',
    });

    if (!template) {
      throw new Error(
        'Payment Confirmation email template not found in database'
      );
    }

    // 2. Get the parent data
    const parent = await Parent.findById(parentId);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    // 3. Get player data
    const players = await Player.find({ _id: { $in: playerIds } });

    // 4. Calculate actual values
    const playerCount = players.length;
    const perPlayerAmount = 1050; // Your fixed amount
    const actualTotalAmount = totalAmount || playerCount * perPlayerAmount;

    // 5. Replace template variables with actual payment data
    let populatedContent = template.content;

    // Replace payment-specific variables
    populatedContent = populatedContent.replace(
      /\[payment\.playerCount\]/g,
      playerCount.toString()
    );
    populatedContent = populatedContent.replace(
      /\[payment\.totalAmount\]/g,
      `$${actualTotalAmount}`
    );
    populatedContent = populatedContent.replace(
      /\[payment\.perPlayerAmount\]/g,
      `$${perPlayerAmount}`
    );
    populatedContent = populatedContent.replace(
      /\[payment\.season\]/g,
      season || 'Basketball Select Team'
    );
    populatedContent = populatedContent.replace(
      /\[payment\.year\]/g,
      year ? year.toString() : new Date().getFullYear().toString()
    );

    // Replace player names if needed
    if (players.length > 0) {
      const playerNames = players.map((p) => p.fullName).join(', ');
      populatedContent = populatedContent.replace(
        /\[players\.names\]/g,
        playerNames
      );
    }

    // Replace parent variables
    populatedContent = populatedContent.replace(
      /\[parent\.fullName\]/g,
      parent.fullName || ''
    );
    populatedContent = populatedContent.replace(
      /\[parent\.email\]/g,
      parent.email || ''
    );

    // 6. Send the email
    const result = await sendEmail({
      to: parent.email,
      subject: template.subject,
      html: populatedContent,
    });

    console.log('Payment confirmation email sent successfully:', {
      parentId,
      playerCount,
      totalAmount: actualTotalAmount,
      email: parent.email,
    });

    return result;
  } catch (err) {
    console.error('Error in sendPaymentConfirmationEmail:', {
      error: err.message,
      parentId,
      playerIds,
      totalAmount,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ PASSWORD RESET EMAIL ============
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

// ============ TRAINING REGISTRATION PENDING PAYMENT EMAIL ============
async function sendTrainingRegistrationPendingEmail(
  parentId,
  playerIds,
  season,
  year,
  packageInfo = null,
  playersData = []
) {
  try {
    // 1. Get the parent data
    const parent = await Parent.findById(parentId);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    // 2. Get player data if playerIds provided, otherwise use playersData
    let players = [];
    if (playerIds && playerIds.length > 0) {
      players = await Player.find({ _id: { $in: playerIds } });
    } else if (playersData && playersData.length > 0) {
      players = playersData;
    }

    // 3. Build package info
    let packageDetails = '';
    if (packageInfo) {
      packageDetails = `
        <p style="margin: 8px 0;"><strong>Training Package:</strong> ${packageInfo.name}</p>
        <p style="margin: 8px 0;"><strong>Package Price:</strong> $${packageInfo.price} per player</p>
      `;
    }

    // 4. Build the training registration email
    const subject = `Training Registration Received - Bothell Select ${season} ${year}`;

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
        </div>
        
        <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">🏀 Training Registration Received!</h1>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
          <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
          
          <p style="font-size: 16px;">Thank you for registering for the Bothell Select ${season} ${year} training program! We've received your registration details for ${players.length} player(s).</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
            <h3 style="margin-top: 0; color: #506ee4;">Training Registration Details</h3>
            <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
            ${packageDetails}
            <p style="margin: 8px 0;"><strong>Program:</strong> ${season} ${year}</p>
            <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
            <ul style="margin: 8px 0;">
              ${players.map((p) => `<li>${p.fullName}</li>`).join('')}
            </ul>
          </div>
          
          <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107;">
            <h4 style="margin-top: 0; color: #856404;">⚠️ Important: Payment Required</h4>
            <p style="margin: 8px 0; color: #856404;">
              <strong>Your training registration is not complete until payment is received.</strong> 
              Please complete your payment to secure your spot(s) in the training program.
            </p>
            <p style="margin: 8px 0; color: #856404;">
              You can complete your payment by logging into your account and visiting the "Training Registrations" section.
            </p>
          </div>
          
          <p style="font-size: 16px;"><strong>What's Next?</strong></p>
          <ul style="font-size: 14px;">
            <li>Complete your payment to secure your player's spot in training</li>
            <li>You will receive training schedule information after payment is completed</li>
            <li>Look out for training materials and session details from your coach</li>
            <li>Training schedules will be shared via email and the team portal</li>
          </ul>
          
          <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
          
          <p style="font-size: 16px; font-weight: bold;">We look forward to training with you! 🏀</p>
        </div>
        
        <div style="background: #e5e7eb; padding: 15px; text-align: center; font-size: 14px; color: #555; border-radius: 0 0 5px 5px;">
          <p style="margin: 0;">Bothell Select Basketball<br>
          bothellselect@proton.me</p>
        </div>
      </div>
    `;

    // 5. Send the email
    const result = await sendEmail({
      to: parent.email,
      subject,
      html: emailHtml,
    });

    console.log(
      'Training registration pending payment email sent successfully:',
      {
        parentId,
        playerCount: players.length,
        season,
        year,
        email: parent.email,
      }
    );

    return result;
  } catch (err) {
    console.error('Error in sendTrainingRegistrationPendingEmail:', {
      error: err.message,
      parentId,
      playerIds,
      season,
      year,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ REGISTRATION PENDING PAYMENT EMAIL ============
async function sendRegistrationPendingEmail(
  parentId,
  playerIds,
  season,
  year,
  packageInfo = null
) {
  try {
    // 1. Get the parent data
    const parent = await Parent.findById(parentId);
    if (!parent) {
      throw new Error(`Parent not found with ID: ${parentId}`);
    }

    // 2. Get player data
    const players = await Player.find({ _id: { $in: playerIds } });

    // 3. Build the pending registration email
    const subject = `Registration Received - Bothell Select ${season} ${year}`;

    // Calculate package info if available
    let packageDetails = '';
    if (packageInfo) {
      packageDetails = `
        <p style="margin: 8px 0;"><strong>Selected Package:</strong> ${packageInfo.name}</p>
        <p style="margin: 8px 0;"><strong>Package Price:</strong> $${packageInfo.price} per player</p>
      `;
    }

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; background: #f9fafb; padding: 20px;">
        <div style="text-align: center; margin-bottom: 20px;">
          <img src="https://bothellselect.com/assets/img/logo.png" alt="Bothell Select Basketball" style="max-width: 200px; height: auto;">
        </div>
        
        <div style="background: #506ee4; color: white; padding: 20px; text-align: center; border-radius: 5px 5px 0 0;">
          <h1 style="margin: 0;">🏀 Registration Received!</h1>
        </div>
        
        <div style="background: white; padding: 20px; border-radius: 0 0 5px 5px;">
          <p style="font-size: 16px;">Dear ${parent.fullName || 'Valued Customer'},</p>
          
          <p style="font-size: 16px;">Thank you for registering for the Bothell Select ${season} ${year} program! We've received your registration details for ${players.length} player(s).</p>
          
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #506ee4;">
            <h3 style="margin-top: 0; color: #506ee4;">Registration Details</h3>
            <p style="margin: 8px 0;"><strong>Number of Players:</strong> ${players.length}</p>
            ${packageDetails}
            <p style="margin: 8px 0;"><strong>Season:</strong> ${season} ${year}</p>
            <p style="margin: 8px 0;"><strong>Players Registered:</strong></p>
            <ul style="margin: 8px 0;">
              ${players.map((p) => `<li>${p.fullName}</li>`).join('')}
            </ul>
          </div>
          
          <div style="background: #fff3cd; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #ffc107;">
            <h4 style="margin-top: 0; color: #856404;">⚠️ Important: Payment Required</h4>
            <p style="margin: 8px 0; color: #856404;">
              <strong>Your registration is not complete until payment is received.</strong> 
              Please complete your payment within 7 days to secure your spot(s) in the program.
            </p>
            <p style="margin: 8px 0; color: #856404;">
              You can complete your payment by logging into your account and visiting the "Registrations" section.
            </p>
          </div>
          
          <p style="font-size: 16px;"><strong>What's Next?</strong></p>
          <ul style="font-size: 14px;">
            <li>Complete your payment to secure your player's spot</li>
            <li>You will receive schedule information after payment is completed</li>
            <li>Look out for welcome materials from your coach</li>
            <li>Practice schedules will be shared via email</li>
          </ul>
          
          <p style="font-size: 14px; color: #555;">If you have any questions, please contact us at bothellselect@proton.me</p>
          
          <p style="font-size: 16px; font-weight: bold;">We look forward to having you in our program! 🏀</p>
        </div>
        
        <div style="background: #e5e7eb; padding: 15px; text-align: center; font-size: 14px; color: #555; border-radius: 0 0 5px 5px;">
          <p style="margin: 0;">Bothell Select Basketball<br>
          bothellselect@proton.me</p>
        </div>
      </div>
    `;

    // 4. Send the email
    const result = await sendEmail({
      to: parent.email,
      subject,
      html: emailHtml,
    });

    console.log('Registration pending payment email sent successfully:', {
      parentId,
      playerCount: players.length,
      season,
      year,
      email: parent.email,
    });

    return result;
  } catch (err) {
    console.error('Error in sendRegistrationPendingEmail:', {
      error: err.message,
      parentId,
      playerIds,
      season,
      year,
      timestamp: new Date().toISOString(),
    });
    throw err;
  }
}

// ============ EXPORTS ============
module.exports = {
  sendEmail,
  sendResetEmail,
  sendWelcomeEmail, // For player/tryout registrations ONLY
  sendTournamentWelcomeEmail, // NEW: For tournament registration (before payment)
  sendTournamentRegistrationEmail, // For tournament registration (after payment)
  sendTryoutEmail,
  sendPaymentConfirmationEmail,
  sendRegistrationPendingEmail,
  sendTrainingRegistrationPendingEmail,
};
