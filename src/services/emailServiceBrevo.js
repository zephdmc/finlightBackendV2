// backend/src/services/emailServiceBrevo.js
require('dotenv').config();

/**
 * Send email using Brevo HTTP API (works on Render - uses Port 443)
 * No SMTP ports needed - bypasses Render firewall completely
 */
const sendEmailViaBrevo = async (to, name, subject, htmlContent) => {
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || process.env.EMAIL_USER;
  const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'FinLight';

  // Validate configuration
  if (!BREVO_API_KEY) {
    console.error('❌ BREVO_API_KEY not configured in environment variables');
    return false;
  }

  if (!SENDER_EMAIL) {
    console.error('❌ Sender email not configured');
    return false;
  }

  const payload = {
    sender: {
      name: SENDER_NAME,
      email: SENDER_EMAIL,
    },
    to: [
      {
        email: to,
        name: name || 'User',
      },
    ],
    subject: subject,
    htmlContent: htmlContent,
  };

  try {
    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': BREVO_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('❌ Brevo API Error:', result);
      return false;
    }

    console.log(`✅ Email sent to ${to} via Brevo HTTP API`);
    console.log(`📧 Message ID: ${result.messageId}`);
    return true;
  } catch (error) {
    console.error('❌ Brevo send error:', error.message);
    return false;
  }
};

/**
 * Send password reset email
 */
const sendPasswordResetEmail = async (email, name, resetUrl) => {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Reset Your Password</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .warning { background: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0; border-radius: 8px; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Reset Your Password</h1>
        </div>
        <div class="content">
          <p>Hello <strong>${name || 'User'}</strong>,</p>
          <p>We received a request to reset the password for your FinLight account.</p>
          <div style="text-align: center;">
            <a href="${resetUrl}" class="button" style="color: white;">Reset Password →</a>
          </div>
          <div class="warning">
            <p>🔒 This link expires in <strong>1 hour</strong> for security.</p>
            <p>If you didn't request this, please ignore this email.</p>
          </div>
          <p>Or copy this link: ${resetUrl}</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} FinLight. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmailViaBrevo(email, name, 'Reset Your Password - FinLight', htmlContent);
};

/**
 * Send organization welcome email
 */
const sendOrganizationWelcomeEmail = async (adminEmail, adminName, organizationName, loginUrl) => {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Welcome to FinLight</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; margin: 20px 0; }
        .details { background: white; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to FinLight! 🎉</h1>
          <p>Your organization has been successfully created</p>
        </div>
        <div class="content">
          <p>Dear <strong>${adminName}</strong>,</p>
          <p>Congratulations! Your organization <strong>${organizationName}</strong> has been successfully set up on the FinLight platform.</p>
          <div class="details">
            <h3>📋 Organization Details:</h3>
            <p><strong>Organization Name:</strong> ${organizationName}</p>
            <p><strong>Admin Email:</strong> ${adminEmail}</p>
            <p><strong>Account Status:</strong> Active ✅</p>
          </div>
          <p>You can now:</p>
          <ul>
            <li>✅ Login to your admin dashboard</li>
            <li>✅ Create payment types (dues, levies, etc.)</li>
            <li>✅ Add and manage members</li>
            <li>✅ Configure bank details to receive payments</li>
          </ul>
          <div style="text-align: center;">
            <a href="${loginUrl}" class="button" style="color: white;">Access Your Dashboard →</a>
          </div>
          <p>Best regards,<br><strong>The FinLight Team</strong></p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} FinLight. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmailViaBrevo(adminEmail, adminName, `Welcome to FinLight - ${organizationName}`, htmlContent);
};
const sendMemberWelcomeEmail = async (email, name, organizationName, loginUrl) => {
  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Welcome to FinLight</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; border-radius: 10px 10px 0 0; }
        .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; }
        .button { display: inline-block; padding: 12px 30px; background: #667eea; color: white; text-decoration: none; border-radius: 5px; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to FinLight 🎉</h1>
        </div>

        <div class="content">
          <p>Hello <strong>${name}</strong>,</p>

          <p>You have been successfully added to <strong>${organizationName}</strong>.</p>

          <p>You can now log in and start using your account.</p>

          <div style="text-align:center; margin: 20px 0;">
            <a href="${loginUrl}" class="button">Login to Dashboard</a>
          </div>

          <p>If you did not expect this, please contact your organization admin.</p>
        </div>

        <div class="footer">
          <p>© ${new Date().getFullYear()} FinLight</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmailViaBrevo(
    email,
    name,
    `Welcome to ${organizationName} - FinLight`,
    htmlContent
  );
};


module.exports = {
  sendPasswordResetEmail,
  sendOrganizationWelcomeEmail,
  sendMemberWelcomeEmail,
};