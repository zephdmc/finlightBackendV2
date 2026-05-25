const User = require('../models/User');
const Payment = require('../models/Payment');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { sendPasswordResetEmail } = require('./emailService');

/**
 * Authentication Service
 * Handles all authentication-related business logic
 * Separates concerns from controllers
 */
class AuthService {
  /**
   * Generate JWT token (with organization support)
   * @param {Object} user - User object
   * @returns {string} - JWT token
   */
  generateToken(user) {
    return jwt.sign(
      { 
        id: user._id,
        organizationId: user.organizationId,
        role: user.role
      },
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
   * Register new user (with organization support)
   * @param {Object} userData - User registration data
   * @returns {Promise<Object>} - Created user and token
   */
  async register(userData) {
    const { name, email, password, role = 'member', organizationId } = userData;

    // Check if user exists in this organization
    const existingUser = await User.findOne({ email, organizationId });
    if (existingUser) {
      const error = new Error('User already exists with this email in your organization');
      error.statusCode = 400;
      throw error;
    }

    // Create user
    const user = await User.create({
      name,
      email,
      password,
      role,
      organizationId
    });

    // If member, create registration payment record
    if (user.role === 'member') {
      await Payment.create({
        user: user._id,
        type: 'registration',
        amount: 500, // Registration fee
        status: 'unpaid',
        organizationId
      });
    }

    // Generate token
    const token = this.generateToken(user);

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        hasPaidRegistration: user.hasPaidRegistration
      },
      token
    };
  }

  /**
   * Login user (with organization support)
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
    const token = this.generateToken(user);

    return {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
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

    // Validate new password strength
    const passwordStrength = this.validatePasswordStrength(newPassword);
    if (!passwordStrength.isValid) {
      const error = new Error(passwordStrength.errors.join(', '));
      error.statusCode = 400;
      throw error;
    }

    // Update password
    user.password = newPassword;
    await user.save();

    return true;
  }

  /**
   * Request password reset (with email sending and secure token hashing)
   * @param {string} email - User email
   * @returns {Promise<Object>} - Reset token (only in development)
   */
  async requestPasswordReset(email) {
    console.log(`📧 Password reset requested for: ${email}`);
    
    // Always return success for security (don't reveal if email exists)
    const user = await User.findOne({ email });
    
    if (!user) {
      console.log(`⚠️ Password reset requested for non-existent email: ${email}`);
      return { success: true };
    }

    // Generate secure reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    
    // 🔐 SECURITY FIX: Hash the token before storing in database
    const hashedToken = crypto
      .createHash('sha256')
      .update(resetToken)
      .digest('hex');
    
    const resetTokenExpiry = Date.now() + 3600000; // 1 hour

    // Store HASHED token (not plain text)
    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = resetTokenExpiry;
    await user.save();

    // Generate reset URL with plain token (for user to click)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;
    
    console.log(`🔗 Reset URL: ${resetUrl}`);
    
    // Send email using Brevo
    const emailSent = await sendPasswordResetEmail(
      user.email, 
      user.name, 
      resetUrl
    );
    
    if (!emailSent) {
      console.error(`❌ Failed to send password reset email to ${email}`);
      // Don't throw error - user will still get success message
    } else {
      console.log(`✅ Password reset email sent to ${email}`);
    }

    // Return token only in development for testing
    if (process.env.NODE_ENV === 'development') {
      return {
        success: true,
        resetToken, // Plain token for testing
        resetUrl
      };
    }
    
    return { success: true };
  }

  /**
   * Reset password with token (verifies hashed token)
   * @param {string} token - Plain reset token from email
   * @param {string} newPassword - New password
   * @returns {Promise<boolean>} - Success status
   */
  async resetPassword(token, newPassword) {
    console.log(`🔐 Attempting password reset with token: ${token?.substring(0, 10)}...`);
    
    // Validate password
    if (!newPassword || newPassword.length < 6) {
      const error = new Error('Password must be at least 6 characters long');
      error.statusCode = 400;
      throw error;
    }

    // 🔐 Hash the incoming token to compare with stored hash
    const hashedToken = crypto
      .createHash('sha256')
      .update(token)
      .digest('hex');

    // Find user with matching HASHED token
    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      console.log(`❌ Invalid or expired reset token used`);
      const error = new Error('Invalid or expired reset token. Please request a new password reset.');
      error.statusCode = 400;
      throw error;
    }

    console.log(`✅ Found user for password reset: ${user.email}`);

    // Validate password strength
    const passwordStrength = this.validatePasswordStrength(newPassword);
    if (!passwordStrength.isValid) {
      const error = new Error(passwordStrength.errors.join(', '));
      error.statusCode = 400;
      throw error;
    }

    // Update password
    user.password = newPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    console.log(`✅ Password reset successful for user: ${user.email}`);

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
    
    // Super admin has full access
    if (userRole === 'super_admin') return true;
    
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

      const newToken = this.generateToken(user);
      
      return {
        token: newToken,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          role: user.role,
          organizationId: user.organizationId
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
    console.log('🚪 Logout requested for token:', token?.substring(0, 20) + '...');
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