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
// backend/src/services/emailServiceBrevo.js

const sendMemberWelcomeEmail = async (email, name, organizationName, loginUrl, password = null) => {
  const passwordSection = password ? `
    <div style="background: #e0e7ff; padding: 15px; border-radius: 8px; margin: 20px 0;">
      <h3 style="margin-top: 0;">🔐 Your Login Credentials:</h3>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Password:</strong> ${password}</p>
      <p style="font-size: 12px; color: #666;">⚠️ Please change your password after first login</p>
    </div>
  ` : '';

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
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #999; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>Welcome to ${organizationName}! 🎉</h1>
        </div>
        <div class="content">
          <p>Hello <strong>${name}</strong>,</p>
          
          <p>You have been successfully registered as a member of <strong>${organizationName}</strong> on FinLight.</p>
          
          ${passwordSection}
          
          <p>You can now log in and start using your account.</p>
          
          <div style="text-align:center; margin: 20px 0;">
            <a href="${loginUrl}" class="button">Login to Dashboard →</a>
          </div>
          
          <p style="font-size: 12px; color: #888;">If you did not expect this email, please ignore it or contact your organization administrator.</p>
        </div>
        <div class="footer">
          <p>© ${new Date().getFullYear()} FinLight. All rights reserved.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmailViaBrevo(email, name, `Welcome to ${organizationName} - Your Account Details`, htmlContent);
};
/**
 * Send payment type notification email (when admin creates or updates a payment type)
 */
const sendPaymentTypeNotificationEmail = async (email, name, paymentType, organizationName, loginUrl, paymentsUrl, isUpdate = false) => {
  const formattedAmount = new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN'
  }).format(paymentType.amount);

  const mandatoryBadge = paymentType.is_mandatory
    ? '<span style="background: #fee2e2; color: #dc2626; padding: 4px 12px; border-radius: 20px; font-size: 12px;">⚠️ MANDATORY</span>'
    : '<span style="background: #e0e7ff; color: #4f46e5; padding: 4px 12px; border-radius: 20px; font-size: 12px;">✨ Optional</span>';

  const frequencyText = paymentType.frequency === 'one-time'
    ? 'One-time payment'
    : `${paymentType.frequency} payment`;

  const subject = isUpdate
    ? `📝 Payment Updated: ${paymentType.name} - ${formattedAmount}`
    : ` New Payment Created: ${paymentType.name} - ${formattedAmount}`;

  const headerTitle = isUpdate ? 'Payment Details Updated' : 'New Payment Created';
  const headerIcon = isUpdate ? '📝' : '!';
  const actionText = isUpdate ? 'View Updated Details' : 'Make Payment Now';

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>${subject}</title>
      <style>
        body { font-family: 'Segoe UI', Arial, sans-serif; line-height: 1.6; color: #333; background: #f6f7fb; margin: 0; padding: 20px; }
        .container { max-width: 600px; margin: 0 auto; background: white; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; text-align: center; }
        .header h1 { margin: 0; font-size: 24px; }
        .content { padding: 30px; }
        .payment-card { background: #f9fafb; border-radius: 12px; padding: 20px; margin: 20px 0; border-left: 4px solid #4f46e5; }
        .amount { font-size: 36px; font-weight: bold; color: #4f46e5; margin: 10px 0; }
        .detail-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
        .detail-label { font-weight: 600; color: #6b7280; }
        .detail-value { color: #111827; }
        .badge { margin: 15px 0; }
        .button { display: inline-block; padding: 14px 32px; background: #4f46e5; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 10px 5px; transition: background 0.3s; }
        .button:hover { background: #4338ca; }
        .button-secondary { background: #6b7280; }
        .button-secondary:hover { background: #4b5563; }
        .footer { text-align: center; padding: 20px; font-size: 12px; color: #9ca3af; border-top: 1px solid #e5e7eb; background: #f9fafb; }
        .warning { background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #f59e0b; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>${headerIcon} ${headerTitle}</h1>
          <p style="margin: 10px 0 0; opacity: 0.9;">${organizationName}</p>
        </div>
        
        <div class="content">
          <p>Dear <strong>${name}</strong>,</p>
          
          <p>${isUpdate ? 'The following payment has been updated by your organization administrator:' : 'A new payment has been created for your organization. Please review the details below:'}</p>
          
          <div class="payment-card">
            <div class="badge">${mandatoryBadge}</div>
            
            <h2 style="margin: 10px 0; color: #111827;">${paymentType.name}</h2>
            
            <div class="amount">${formattedAmount}</div>
            
            <div class="detail-row">
              <span class="detail-label">Payment Type:</span>
              <span class="detail-value">${paymentType.type || 'General'}</span>
            </div>
            
            <div class="detail-row">
              <span class="detail-label">Frequency:</span>
              <span class="detail-value">${frequencyText}</span>
            </div>
            
            ${paymentType.description ? `
            <div class="detail-row">
              <span class="detail-label">Description:</span>
              <span class="detail-value">${paymentType.description}</span>
            </div>
            ` : ''}
          </div>
          
          ${paymentType.is_mandatory ? `
            <div class="warning">
              ⚠️ <strong>Important:</strong> This is a mandatory payment. Please ensure you make this payment by the due date to avoid penalties.
            </div>
          ` : ''}
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${paymentsUrl}" class="button">${actionText} →</a>
            <a href="${loginUrl}" class="button button-secondary">Go to Dashboard</a>
          </div>
          
          <p style="font-size: 14px; color: #6b7280;">If you have any questions about this payment, please contact your organization administrator.</p>
        </div>
        
        <div class="footer">
          <p>© ${new Date().getFullYear()} FinLight. All rights reserved.</p>
          <p>This is an automated message, please do not reply.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  return await sendEmailViaBrevo(email, name, subject, htmlContent);
};

module.exports = {
  sendPasswordResetEmail,
  sendOrganizationWelcomeEmail,
  sendMemberWelcomeEmail,
  sendPaymentTypeNotificationEmail  // Add this line

};