const express = require('express');
const router = express.Router();
// TEMPORARY TEST ROUTE - Remove after debugging
router.post('/test-login', (req, res) => {
    console.log('🔥 TEST ROUTE HIT!');
    res.json({ 
      success: true, 
      message: 'Test route is working!',
      timestamp: new Date().toISOString()
    });
  });

const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');

// Import body and param from express-validator
const { body, param } = require('express-validator');

/**
 * @route   POST /api/auth/register
 * @desc    Register a new user
 * @access  Public
 */
router.post(
  '/register',
  ValidationMiddleware.auth.register,
  authController.register
);

/**
 * @route   POST /api/auth/login
 * @desc    Login user
 * @access  Public
 */
router.post(
  '/login',
  ValidationMiddleware.auth.login,
  authController.login
);

/**
 * @route   GET /api/auth/me
 * @desc    Get current logged in user
 * @access  Private
 */
router.get('/me', protect, authController.getMe);

/**
 * @route   POST /api/auth/logout
 * @desc    Logout user
 * @access  Private
 */
router.post('/logout', protect, (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Logged out successfully'
  });
});

/**
 * @route   POST /api/auth/change-password
 * @desc    Change user password
 * @access  Private
 */
router.post(
  '/change-password',
  protect,
  [
    body('currentPassword')
      .notEmpty()
      .withMessage('Current password is required'),

    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('New password must be at least 6 characters long')
      .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
      .withMessage('New password must contain at least one letter and one number'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const authService = require('../services/authService');
      await authService.changePassword(
        req.user.id,
        req.body.currentPassword,
        req.body.newPassword
      );
      
      res.status(200).json({
        success: true,
        message: 'Password changed successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/auth/forgot-password
 * @desc    Request password reset
 * @access  Public
 */
router.post(
  '/forgot-password',
  [
    body('email')
      .isEmail()
      .withMessage('Please provide a valid email')
      .normalizeEmail(),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const authService = require('../services/authService');
      const resetData = await authService.requestPasswordReset(req.body.email);
      
      res.status(200).json({
        success: true,
        message: 'Password reset email sent',
        resetToken: process.env.NODE_ENV === 'development' ? resetData.resetToken : undefined
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/auth/reset-password/:token
 * @desc    Reset password with token
 * @access  Public
 */
router.post(
  '/reset-password/:token',
  [
    param('token')
      .notEmpty()
      .withMessage('Reset token is required'),
    body('newPassword')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters long')
      .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
      .withMessage('Password must contain at least one letter and one number'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const authService = require('../services/authService');
      await authService.resetPassword(req.params.token, req.body.newPassword);
      
      res.status(200).json({
        success: true,
        message: 'Password reset successful'
      });
    } catch (error) {
      next(error);
    }
  }
);

// Check member registration limit (Admin only)
router.get(
    '/check-member-limit',
    protect,
    roleCheck('admin'),
    authController.checkMemberLimit
  );

/**
 * @route   POST /api/auth/refresh-token
 * @desc    Refresh JWT token
 * @access  Private
 */
router.post(
  '/refresh-token',
  [
    body('token')
      .notEmpty()
      .withMessage('Token is required'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const authService = require('../services/authService');
      const result = await authService.refreshToken(req.body.token);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/auth/verify-admin-pin
 * @desc    Verify admin PIN for direct payments
 * @access  Private/Admin
 */
router.post(
  '/verify-admin-pin',
  protect,
  roleCheck('admin'),
  [
    body('pin')
      .notEmpty()
      .withMessage('PIN is required')
      .isLength({ min: 4, max: 6 })
      .withMessage('PIN must be 4-6 digits')
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const { pin } = req.body;
      
      // Get admin PIN from environment variable
      // You can also store this in database for multiple admins
      const adminPin = process.env.ADMIN_PIN || '1234';
      
      if (pin === adminPin) {
        res.status(200).json({
          success: true,
          message: 'PIN verified successfully'
        });
      } else {
        res.status(401).json({
          success: false,
          message: 'Invalid admin PIN'
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;