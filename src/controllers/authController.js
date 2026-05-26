// backend/src/controllers/authController.js
const User = require('../models/User');
const Payment = require('../models/Payment');
const Organization = require('../models/Organization'); // 🆕
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const { addToEmailQueue } = require('../services/emailQueue');
const { sendEmailViaBrevo } = require('../services/emailServiceBrevo');
const { sendOrganizationWelcomeEmail } = require('../services/emailService');
const mongoose = require('mongoose');
// Generate JWT Token (now includes organizationId)
const generateToken = (user) => {
  return jwt.sign(
    {
      id: user._id,
      organizationId: user.organizationId,  // critical for multi‑tenancy
      role: user.role
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRE }
  );
};

// @desc    Register user (Admin only – creates a user under a specific organization)
// @route   POST /api/auth/register
// @access  Private/Admin (or SuperAdmin)
exports.register = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, email, phoneNumber, password, role, organizationId } = req.body; // Added phoneNumber

    // Determine organizationId: 
    // - If caller is super admin, they can specify any organizationId.
    // - If caller is a regular admin, use their own organizationId.
    let targetOrgId = organizationId;
    if (req.user?.role === 'admin' && !req.user?.isSuperAdmin) {
      // Regular admin can only create users under their own organization
      targetOrgId = req.user.organizationId;
    }
    if (!targetOrgId) {
      return res.status(400).json({
        success: false,
        message: 'Organization ID is required'
      });
    }

    // Verify organization exists
    const organization = await Organization.findById(targetOrgId);
    if (!organization) {
      return res.status(404).json({
        success: false,
        message: 'Organization not found'
      });
    }

    // Check if user exists (email + organization unique)
    const existingUser = await User.findOne({ email, organizationId: targetOrgId });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'User already exists in this organization'
      });
    }

    // Check member registration limit (only for member role, scoped to organization)
    if (role === 'member' || !role) {
      const memberCount = await User.countDocuments({ role: 'member', organizationId: targetOrgId });
      const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS) || 25;
      if (memberCount >= MAX_MEMBERS) {
        return res.status(400).json({
          success: false,
          message: `Member registration limit reached for this organization. Maximum of ${MAX_MEMBERS} members allowed.`,
          data: { currentMembers: memberCount, maxMembers: MAX_MEMBERS }
        });
      }
    }

    // Create user with organizationId and phoneNumber
    const user = await User.create({
      name,
      email,
      phoneNumber: phoneNumber || '', // Added phoneNumber
      password,
      role: role || 'member',
      organizationId: targetOrgId
    });

    // If member, create registration payment record (scoped to organization)
    if (user.role === 'member') {
      await Payment.create({
        user: user._id,
        type: 'registration',
        amount: 500, // Registration fee – configurable
        status: 'unpaid',
        organizationId: targetOrgId   // 🆕
      });
    }
    addToEmailQueue({
      name: `member-welcome-${user.email}`,
      maxRetries: 5,
      task: async () => {
        const loginUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/login`;

        const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Welcome to FinLight</title>
      </head>
      <body style="font-family: Arial, sans-serif; background:#f4f4f4; padding:20px;">
        <div style="max-width:600px;margin:auto;background:white;padding:20px;border-radius:10px;">
          
          <h2 style="color:#4f46e5;">Welcome to FinLight 🎉</h2>
          
          <p>Hello <strong>${user.name}</strong>,</p>

          <p>You have been successfully registered under your organization.</p>

          <div style="background:#f9fafb;padding:15px;border-radius:8px;margin:15px 0;">
            <p><strong>Organization:</strong> ${organization.name}</p>
            <p><strong>Role:</strong> ${user.role}</p>
            <p><strong>Email:</strong> ${user.email}</p>
          </div>

          <p>You can now log in and access your dashboard.</p>

          <a href="${loginUrl}" 
             style="display:inline-block;padding:10px 20px;background:#4f46e5;color:white;text-decoration:none;border-radius:5px;">
             Login to your account
          </a>

          <p style="margin-top:20px;font-size:12px;color:#777;">
            © ${new Date().getFullYear()} FinLight
          </p>

        </div>
      </body>
      </html>
    `;

        await sendEmailViaBrevo(
          user.email,
          user.name,
          `Welcome to FinLight - ${organization.name}`,
          htmlContent
        );
      }
    });

    const token = generateToken(user);

    // Return user with phoneNumber
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber || '', // Added phoneNumber
        role: user.role,
        organizationId: user.organizationId,
        hasPaidRegistration: user.hasPaidRegistration
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Verify admin pin (optional, remains unchanged)
// @route   POST /api/auth/verify-admin-pin
// @access  Private/Admin
exports.verifyAdminPin = async (req, res, next) => {
  try {
    const { pin } = req.body;
    const adminPin = process.env.ADMIN_PIN || '1234';
    if (pin === adminPin) {
      res.status(200).json({ success: true, message: 'PIN verified successfully' });
    } else {
      res.status(401).json({ success: false, message: 'Invalid admin PIN' });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Login user (returns organizationId in token and response)
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;
    console.log("=== LOGIN ATTEMPT ===");
    console.log("Email:", email);

    // Find user (email is unique only within organization, but globally we must find one)
    // Note: If the same email exists in multiple organizations, we need to decide.
    // For simplicity, we assume email is unique across the whole system (as defined in User model).
    // If you want email per organization, change the index (email+organizationId unique)
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      console.log("User not found for email:", email);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log("Password mismatch for user:", email);
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const token = generateToken(user);

    // Return user with phoneNumber
    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber || '', // Added phoneNumber
        role: user.role,
        organizationId: user.organizationId,
        hasPaidRegistration: user.hasPaidRegistration
      }
    });
  } catch (error) {
    console.error("Login error:", error);
    next(error);
  }
};

/**
 * @desc    Register a new organization + its first admin user
 * @route   POST /api/auth/signup
 * @access  Public
 */
exports.signupWithOrg = async (req, res, next) => {
  try {
    const { orgName, adminName, adminEmail, adminPassword } = req.body;

    // 1. Validate input
    if (!orgName || !adminName || !adminEmail || !adminPassword) {
      return res.status(400).json({
        success: false,
        message: 'All fields are required'
      });
    }

    if (adminPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters'
      });
    }

    // 2. Generate slug from org name
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // 3. Check if organization slug already exists
    const existingOrg = await Organization.findOne({ slug });
    if (existingOrg) {
      return res.status(400).json({
        success: false,
        message: 'Organization name already taken. Please choose another name.'
      });
    }

    // 4. Check if email is already used (globally - for security)
    const existingUser = await User.findOne({ email: adminEmail });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'This email is already registered. Please use a different email or login.'
      });
    }

    // 5. Create the organization
    const organization = await Organization.create({
      name: orgName,
      slug,
      paystack: {
        subaccountCode: '',
        bankName: '',
        accountNumber: '',
        percentageCharge: 0
      },
      status: 'active',
      settings: {
        registrationFee: 500,
        currency: 'NGN',
        timezone: 'Africa/Lagos'
      },
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 6. Create the admin user (no phoneNumber for admin signup)
    const user = await User.create({
      name: adminName,
      email: adminEmail,
      password: adminPassword,
      role: 'admin',
      organizationId: organization._id,
      hasPaidRegistration: true,
      hasCompletedRegistration: true,
      isActive: true,
      phoneNumber: '', // Added phoneNumber field
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // 7. Generate JWT token
    const token = jwt.sign(
      {
        id: user._id,
        organizationId: organization._id,
        role: 'admin'
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
    // 8. Send welcome email (non-blocking)
    addToEmailQueue({
      name: `welcome-${user.email}`,
      maxRetries: 5,
      task: async () => {
        const loginUrl = `${process.env.FRONTEND_URL}/login`;

        await sendOrganizationWelcomeEmail(
          user.email,
          user.name,
          organization.name,
          loginUrl
        );
      }
    });
    // Return user with phoneNumber
    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber || '', // Added phoneNumber
        role: user.role,
        organizationId: organization._id,
        hasPaidRegistration: true
      },
      organization: {
        id: organization._id,
        name: organization.name,
        slug: organization.slug
      },
      message: 'Organization created successfully! Welcome to FinLight.'
    });
  } catch (error) {
    console.error('Signup error:', error);

    // Handle duplicate key error
    if (error.code === 11000) {
      if (error.keyPattern?.slug) {
        return res.status(400).json({
          success: false,
          message: 'Organization name already taken. Please choose another name.'
        });
      }
      if (error.keyPattern?.email) {
        return res.status(400).json({
          success: false,
          message: 'Email already registered. Please use a different email.'
        });
      }
    }

    next(error);
  }
};

/**
 * @desc    Request password reset
 * @route   POST /api/auth/forgot-password
 * @access  Public
 */
exports.forgotPassword = async (req, res, next) => {
  try {
    const authService = require('../services/authService');
    const resetData = await authService.requestPasswordReset(req.body.email);

    res.status(200).json({
      success: true,
      message: 'If an account exists with this email, you will receive a password reset link.',
      ...(process.env.NODE_ENV === 'development' && { resetToken: resetData.resetToken })
    });
  } catch (error) {
    // Don't reveal if email exists or not for security
    console.error('Password reset request error:', error.message);
    res.status(200).json({
      success: true,
      message: 'If an account exists with this email, you will receive a password reset link.'
    });
  }
};

/**
 * @desc    Reset password with token
 * @route   POST /api/auth/reset-password/:token
 * @access  Public
 */
exports.resetPassword = async (req, res, next) => {
  try {
    const authService = require('../services/authService');
    await authService.resetPassword(req.params.token, req.body.newPassword);

    res.status(200).json({
      success: true,
      message: 'Password reset successful. Please login with your new password.'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Change user password
 * @route   POST /api/auth/change-password
 * @access  Private
 */
exports.changePassword = async (req, res, next) => {
  try {
    const authService = require('../services/authService');
    await authService.changePassword(
      req.user.id,
      req.body.currentPassword,
      req.body.newPassword
    );

    res.status(200).json({
      success: true,
      message: 'Password changed successfully. Please login again with your new password.'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Refresh JWT token
 * @route   POST /api/auth/refresh-token
 * @access  Private
 */
exports.refreshToken = async (req, res, next) => {
  try {
    const authService = require('../services/authService');
    const result = await authService.refreshToken(req.body.token);

    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Logout user
 * @route   POST /api/auth/logout
 * @access  Private
 */
exports.logout = async (req, res, next) => {
  try {
    // Log logout event
    console.log(`User logged out: ${req.user.email} from IP ${req.ip}`);

    // If using token blacklist, add token to blacklist here
    // const token = req.headers.authorization?.split(' ')[1];
    // await BlacklistToken.create({ token, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    res.status(200).json({
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    next(error);
  }
};

/**
 * @desc    Verify admin PIN
 * @route   POST /api/auth/verify-admin-pin
 * @access  Private/Admin
 */
exports.verifyAdminPin = async (req, res, next) => {
  try {
    const { pin } = req.body;
    const adminPin = process.env.ADMIN_PIN;

    if (!adminPin && process.env.NODE_ENV === 'production') {
      console.error('ADMIN_PIN not set in production environment');
      return res.status(500).json({
        success: false,
        message: 'System configuration error'
      });
    }

    const validPin = adminPin || (process.env.NODE_ENV === 'development' ? '1234' : null);

    if (!validPin) {
      return res.status(500).json({
        success: false,
        message: 'PIN validation not configured'
      });
    }

    // Track PIN attempts (you may want to use Redis or a database for this)
    const pinAttempts = req.session?.pinAttempts || 0;
    if (pinAttempts >= 5) {
      return res.status(429).json({
        success: false,
        message: 'Too many PIN attempts. Please try again later.'
      });
    }

    if (pin === validPin) {
      console.log(`Admin PIN verified by ${req.user.email} (ID: ${req.user.id})`);
      if (req.session) req.session.pinAttempts = 0;

      res.status(200).json({
        success: true,
        message: 'PIN verified successfully'
      });
    } else {
      if (req.session) {
        req.session.pinAttempts = (req.session.pinAttempts || 0) + 1;
      }

      console.warn(`Failed admin PIN attempt by ${req.user.email} (ID: ${req.user.id}) from IP ${req.ip}`);

      res.status(401).json({
        success: false,
        message: 'Invalid admin PIN'
      });
    }
  } catch (error) {
    next(error);
  }
};

// @desc    Check member registration limit (scoped to organization)
// @route   GET /api/auth/check-member-limit
// @access  Private/Admin
exports.checkMemberLimit = async (req, res, next) => {
  try {
    const organizationId = req.user.organizationId;  // from JWT
    const memberCount = await User.countDocuments({ role: 'member', organizationId });
    const MAX_MEMBERS = parseInt(process.env.MAX_MEMBERS) || 25;
    const availableSlots = Math.max(0, MAX_MEMBERS - memberCount);
    const isFull = memberCount >= MAX_MEMBERS;

    res.status(200).json({
      success: true,
      data: {
        currentMembers: memberCount,
        maxMembers: MAX_MEMBERS,
        availableSlots,
        isFull,
        percentageFull: (memberCount / MAX_MEMBERS) * 100
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get current user (already includes organizationId from DB)
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phoneNumber: user.phoneNumber || '', // Added phoneNumber
        role: user.role,
        organizationId: user.organizationId,
        hasPaidRegistration: user.hasPaidRegistration
      }
    });
  } catch (error) {
    next(error);
  }
};