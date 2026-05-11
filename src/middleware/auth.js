// backend/src/middleware/auth.js
const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Not authorized to access this route'
      });
    }

    // Verify token and extract payload
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Ensure token contains organizationId (should be added during login/register)
    if (!decoded.organizationId) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token: missing organization context'
      });
    }

    // Fetch user from database, ensuring it belongs to the organization from token
    const user = await User.findOne({
      _id: decoded.id,
      organizationId: decoded.organizationId
    }).select('-password');

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found or does not belong to this organization'
      });
    }

    // Attach full user object and organizationId to req.user
    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      organizationId: user.organizationId,
      hasPaidRegistration: user.hasPaidRegistration  // if this field exists
    };
    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    return res.status(401).json({
      success: false,
      message: 'Not authorized to access this route'
    });
  }
};

/**
 * Middleware to check if member has paid registration fee.
 * Admins are automatically allowed.
 * Note: This relies on req.user.hasPaidRegistration field.
 * If that field doesn't exist on User model, you may need to compute it dynamically.
 */
const requireRegistrationPayment = async (req, res, next) => {
  // Admins bypass registration payment check
  if (req.user.role === 'admin') {
    return next();
  }

  // For members, check the `hasPaidRegistration` flag (ensure it's updated when payment is made)
  if (!req.user.hasPaidRegistration) {
    return res.status(403).json({
      success: false,
      message: 'Please pay registration fee to access dashboard'
    });
  }

  next();
};

module.exports = { protect, requireRegistrationPayment };