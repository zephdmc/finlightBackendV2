const nodemailer = require('nodemailer');

// Create transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: process.env.EMAIL_PORT || 587,
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

/**
 * Send organization welcome email to admin
 */
const sendOrganizationWelcomeEmail = async (adminEmail, adminName, organizationName, loginUrl) => {
  const mailOptions = {
    from: `"${process.env.EMAIL_FROM_NAME || 'FinLight'}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
    to: adminEmail,
    subject: `Welcome to FinLight - ${organizationName} Organization Created!`,
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Welcome to FinLight</title>
        <style>
          body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; line-height: 1.6; color: #333; }
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
              <li>✅ Track member payments and generate reports</li>
            </ul>
            
            <div style="text-align: center;">
              <a href="${loginUrl}" class="button" style="color: white;">Access Your Dashboard →</a>
            </div>
            
            <p><strong>Next Steps:</strong></p>
            <ol>
              <li>Log in using your admin credentials</li>
              <li>Configure your bank details in Organization Settings to receive payments</li>
              <li>Create payment types for your members</li>
              <li>Start adding members to your organization</li>
            </ol>
            
            <p>If you have any questions or need assistance, please don't hesitate to contact our support team.</p>
            
            <p>Best regards,<br>
            <strong>The FinLight Team</strong></p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} FinLight. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Welcome email sent to ${adminEmail}`);
    return true;
  } catch (error) {
    console.error('Error sending welcome email:', error);
    return false;
  }
};


/**
 * Send password reset email to user
 * @param {string} email - User's email address
 * @param {string} name - User's name
 * @param {string} resetUrl - Password reset URL
 */
const sendPasswordResetEmail = async (email, name, resetUrl) => {
    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME || 'FinLight'}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Request - FinLight',
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Reset Your Password</title>
          <style>
            body {
              font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
              line-height: 1.6;
              color: #333;
              margin: 0;
              padding: 0;
              background-color: #f4f7fa;
            }
            .container {
              max-width: 600px;
              margin: 0 auto;
              padding: 20px;
            }
            .email-wrapper {
              background: white;
              border-radius: 16px;
              overflow: hidden;
              box-shadow: 0 4px 15px rgba(0,0,0,0.1);
            }
            .header {
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              padding: 40px 30px;
              text-align: center;
            }
            .logo {
              font-size: 28px;
              font-weight: bold;
              margin-bottom: 10px;
            }
            .logo span {
              font-weight: normal;
            }
            .header h1 {
              margin: 0;
              font-size: 24px;
              font-weight: 500;
            }
            .content {
              padding: 40px 30px;
            }
            .greeting {
              font-size: 18px;
              margin-bottom: 20px;
            }
            .message {
              color: #555;
              margin-bottom: 25px;
            }
            .button-container {
              text-align: center;
              margin: 30px 0;
            }
            .reset-button {
              display: inline-block;
              padding: 14px 35px;
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              color: white;
              text-decoration: none;
              border-radius: 50px;
              font-weight: 600;
              font-size: 16px;
              transition: transform 0.2s, box-shadow 0.2s;
              box-shadow: 0 4px 10px rgba(102, 126, 234, 0.3);
            }
            .reset-button:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 15px rgba(102, 126, 234, 0.4);
            }
            .fallback-link {
              background: #f5f5f5;
              padding: 15px;
              border-radius: 8px;
              margin: 20px 0;
              word-break: break-all;
              font-size: 12px;
              font-family: monospace;
            }
            .warning-box {
              background: #fff3cd;
              border-left: 4px solid #ffc107;
              padding: 15px;
              margin: 25px 0;
              border-radius: 8px;
            }
            .warning-box p {
              margin: 0;
              color: #856404;
              font-size: 13px;
            }
            .divider {
              height: 1px;
              background: #e0e0e0;
              margin: 25px 0;
            }
            .footer {
              background: #f8f9fa;
              padding: 25px 30px;
              text-align: center;
              border-top: 1px solid #eee;
            }
            .footer p {
              margin: 5px 0;
              font-size: 12px;
              color: #888;
            }
            .security-badge {
              display: inline-block;
              background: #e8f5e9;
              color: #2e7d32;
              padding: 4px 12px;
              border-radius: 20px;
              font-size: 12px;
              margin-top: 15px;
            }
            @media only screen and (max-width: 480px) {
              .header {
                padding: 30px 20px;
              }
              .content {
                padding: 25px 20px;
              }
              .reset-button {
                padding: 12px 25px;
                font-size: 14px;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="email-wrapper">
              <div class="header">
                <div class="logo">Fin<span>Light</span></div>
                <h1>Reset Your Password</h1>
              </div>
              
              <div class="content">
                <div class="greeting">
                  Hello <strong>${name}</strong>,
                </div>
                
                <div class="message">
                  We received a request to reset the password for your FinLight account associated with this email address.
                  Click the button below to create a new password:
                </div>
                
                <div class="button-container">
                  <a href="${resetUrl}" class="reset-button" target="_blank">
                    Reset Password →
                  </a>
                </div>
                
                <div class="warning-box">
                  <p>🔒 This password reset link will expire in <strong>1 hour</strong> for your security.</p>
                  <p style="margin-top: 8px;">If you did not request a password reset, you can safely ignore this email. Your password will not be changed.</p>
                </div>
                
                <div class="fallback-link">
                  <p style="margin-bottom: 8px; font-weight: 600;">Having trouble clicking the button?</p>
                  <p style="margin: 0;">Copy and paste this URL into your browser:</p>
                  <p style="margin-top: 8px; word-break: break-all;">${resetUrl}</p>
                </div>
                
                <div class="divider"></div>
                
                <div style="text-align: center;">
                  <span class="security-badge">
                    🔐 Secure password reset request
                  </span>
                </div>
              </div>
              
              <div class="footer">
                <p>© ${new Date().getFullYear()} FinLight. All rights reserved.</p>
                <p>This is an automated message, please do not reply to this email.</p>
                <p style="margin-top: 10px;">
                  <small>FinLight • Financial Management Platform</small>
                </p>
              </div>
            </div>
          </div>
        </body>
        </html>
      `
    };
  
    try {
      await transporter.sendMail(mailOptions);
      console.log(`Password reset email sent to ${email}`);
      return true;
    } catch (error) {
      console.error('Error sending password reset email:', error);
      return false;
    }
  };

module.exports = {
  sendOrganizationWelcomeEmail,
    sendPasswordResetEmail
};