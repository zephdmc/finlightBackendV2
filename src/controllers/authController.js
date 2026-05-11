// backend/src/controllers/authController.js
const User = require('../models/User');
const Payment = require('../models/Payment');
const Organization = require('../models/Organization'); // 🆕
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');

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

    const { name, email, password, role, organizationId } = req.body;

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

    // Create user with organizationId
    const user = await User.create({
      name,
      email,
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

    const token = generateToken(user);

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
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

    res.status(200).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
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
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orgName, adminName, adminEmail, adminPassword } = req.body;

    // 1. Validate input
    if (!orgName || !adminName || !adminEmail || !adminPassword) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }
    if (adminPassword.length < 6) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
    }

    // 2. Generate slug from org name (e.g., "AGFMA" -> "agfma")
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // 3. Check if organization slug already exists
    const existingOrg = await Organization.findOne({ slug }).session(session);
    if (existingOrg) {
      await session.abortTransaction();
      session.endSession();
      return res.status(400).json({ success: false, message: 'Organization name already taken' });
    }

    // 4. Create the organization (paystack subaccount can be added later)
    const [organization] = await Organization.create([{
      name: orgName,
      slug,
      paystack: { subaccountCode: '', bankName: '', accountNumber: '', percentageCharge: 0 }
    }], { session });

    // 5. Create the admin user – the User model's pre-save will hash the password automatically
    const [user] = await User.create([{
      name: adminName,
      email: adminEmail,
      password: adminPassword,   // plain text – model hook will hash it
      role: 'admin',
      organizationId: organization._id
    }], { session });

    await session.commitTransaction();
    session.endSession();

    // 6. Generate JWT token (include organizationId)
    const token = jwt.sign(
      { id: user._id, organizationId: organization._id, role: 'admin' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: organization._id
      },
      organization: {
        id: organization._id,
        name: organization.name,
        slug: organization.slug
      }
    });
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
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
        role: user.role,
        organizationId: user.organizationId,
        hasPaidRegistration: user.hasPaidRegistration
      }
    });
  } catch (error) {
    next(error);
  }
};