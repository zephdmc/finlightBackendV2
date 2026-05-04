const User = require('../models/User');
const Payment = require('../models/Payment');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

/**
 * Authentication Service
 * Handles all authentication-related business logic
 * Separates concerns from controllers
 */
class AuthService {
  /**
   * Generate JWT token
   * @param {string} userId - User ID
   * @returns {string} - JWT token
   */
  generateToken(userId) {
    return jwt.sign(
      { id: userId },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRE || '7d' }
    );
  }

  /**
   * Verify JWT token
   * @param {string} token - JWT token
   * @returns {Object} - Decoded token payload
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      throw new Error('Invalid or expired token');
    }
  }

  /**
   * Register new user
   * @param {Object} userData - User registration data
   * @returns {Promise<Object>} - Created user and token
   */
  async register(userData) {
    const { name, email, password, role = 'member' } = userData;

    // Check if user exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      const error = new Error('User already exists with this email');
      error.statusCode = 400;
      throw error;
    }

    // Create user
    const user = await User.create({
      name,
      email,
      password,
      role
    });

    // If member, create registration payment record
    if (user.role === 'member') {
      await Payment.create({
        user: user._id,
        type: 'registration',
        amount: 500, // Registration fee
        status: 'unpaid'
      });
    }

    // Generate token
    const token = this.generateToken(user._id);

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hasPaidRegistration: user.hasPaidRegistration
      },
      token
    };
  }

  /**
   * Login user
   * @param {string} email - User email
   * @param {string} password - User password
   * @returns {Promise<Object>} - User data and token
   */
  async login(email, password) {
    // Find user with password field
    const user = await User.findOne({ email }).select('+password');
    
    if (!user) {
      const error = new Error('Invalid credentials');
      error.statusCode = 401;
      throw error;
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      const error = new Error('Invalid credentials');
      error.statusCode = 401;
      throw error;
    }

    // Generate token
    const token = this.generateToken(user._id);

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        hasPaidRegistration: user.hasPaidRegistration
      },
      token
    };
  }

  /**
   * Change password
   * @param {string} userId - User ID
   * @param {string} currentPassword - Current password
   * @param {string} newPassword - New password
   * @returns {Promise<boolean>} - Success status
   */
  async changePassword(userId, currentPassword, newPassword) {
    const user = await User.findById(userId).select('+password');
    
    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    // Verify current password
    const isPasswordValid = await user.comparePassword(currentPassword);
    if (!isPasswordValid) {
      const error = new Error('Current password is incorrect');
      error.statusCode = 401;
      throw error;
    }

    // Update password
    user.password = newPassword;
    await user.save();

    return true;
  }

  /**
   * Request password reset
   * @param {string} email - User email
   * @returns {Promise<Object>} - Reset token
   */
  async requestPasswordReset(email) {
    const user = await User.findOne({ email });
    
    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour

    user.resetPasswordToken = resetToken;
    user.resetPasswordExpiry = resetTokenExpiry;
    await user.save();

    return {
      resetToken,
      email: user.email,
      name: user.name
    };
  }

  /**
   * Reset password with token
   * @param {string} token - Reset token
   * @param {string} newPassword - New password
   * @returns {Promise<boolean>} - Success status
   */
  async resetPassword(token, newPassword) {
    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpiry: { $gt: Date.now() }
    });

    if (!user) {
      const error = new Error('Invalid or expired reset token');
      error.statusCode = 400;
      throw error;
    }

    // Update password
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpiry = undefined;
    await user.save();

    return true;
  }

  /**
   * Validate user access to resource
   * @param {string} userId - Current user ID
   * @param {string} resourceUserId - Resource owner ID
   * @param {string} userRole - Current user role
   * @returns {boolean} - Whether access is allowed
   */
  validateAccess(userId, resourceUserId, userRole) {
    // Admin has full access
    if (userRole === 'admin') return true;
    
    // Users can only access their own resources
    return userId === resourceUserId;
  }

  /**
   * Check if member has paid registration
   * @param {string} userId - User ID
   * @returns {Promise<boolean>} - Payment status
   */
  async hasPaidRegistration(userId) {
    const user = await User.findById(userId);
    if (!user) return false;
    
    if (user.role === 'admin') return true;
    
    return user.hasPaidRegistration;
  }

  /**
   * Refresh token
   * @param {string} oldToken - Old JWT token
   * @returns {Promise<Object>} - New token
   */
  async refreshToken(oldToken) {
    try {
      const decoded = this.verifyToken(oldToken);
      const user = await User.findById(decoded.id);
      
      if (!user) {
        const error = new Error('User not found');
        error.statusCode = 404;
        throw error;
      }

      const newToken = this.generateToken(user._id);
      
      return {
        token: newToken,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role
        }
      };
    } catch (error) {
      const err = new Error('Invalid refresh token');
      err.statusCode = 401;
      throw err;
    }
  }

  /**
   * Logout (invalidate token)
   * Note: With JWT, we typically don't invalidate on server
   * This is a placeholder for token blacklist if needed
   * @param {string} token - Token to invalidate
   */
  async logout(token) {
    // In a production app, you might want to implement token blacklisting
    // using Redis or a database table
    console.log('Logout requested for token:', token.substring(0, 20) + '...');
    return true;
  }

  /**
   * Get user session data
   * @param {string} userId - User ID
   * @returns {Promise<Object>} - User session data
   */
  async getSession(userId) {
    const user = await User.findById(userId).select('-password');
    
    if (!user) {
      const error = new Error('User not found');
      error.statusCode = 404;
      throw error;
    }

    // Get pending payments count for members
    let pendingPayments = 0;
    if (user.role === 'member') {
      pendingPayments = await Payment.countDocuments({
        user: userId,
        status: 'unpaid'
      });
    }

    return {
      user,
      session: {
        pendingPayments,
        lastLogin: new Date(),
        role: user.role
      }
    };
  }

  /**
   * Validate password strength
   * @param {string} password - Password to validate
   * @returns {Object} - Validation result
   */
  validatePasswordStrength(password) {
    const errors = [];
    
    if (password.length < 8) {
      errors.push('Password must be at least 8 characters long');
    }
    
    if (!/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }
    
    if (!/[a-z]/.test(password)) {
      errors.push('Password must contain at least one lowercase letter');
    }
    
    if (!/[0-9]/.test(password)) {
      errors.push('Password must contain at least one number');
    }
    
    if (!/[!@#$%^&*]/.test(password)) {
      errors.push('Password must contain at least one special character (!@#$%^&*)');
    }
    
    return {
      isValid: errors.length === 0,
      errors
    };
  }
}

module.exports = new AuthService();