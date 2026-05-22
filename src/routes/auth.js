const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const authController = require('../controllers/authController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const { body, param } = require('express-validator');

// ==================== RATE LIMITING ====================

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Too many authentication attempts. Please try again after 15 minutes.' },
});

const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many requests. Please try again later.' },
});

const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { success: false, message: 'Organization signup rate limit exceeded. Please try again later.' },
});

// ==================== CUSTOM VALIDATION RULES ====================

const validateSignup = [
  body('orgName').notEmpty().trim().isLength({ min: 3, max: 100 })
    .matches(/^[a-zA-Z0-9\s&-]+$/),
  body('adminName').notEmpty().trim().isLength({ min: 2, max: 100 })
    .matches(/^[a-zA-Z\s'-]+$/),
  body('adminEmail').isEmail().normalizeEmail(),
  body('adminPassword').isLength({ min: 8, max: 100 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  body('adminPhone').optional().matches(/^[0-9+\-\s()]+$/).isLength({ max: 20 }),
  ValidationMiddleware.validate
];

const validateForgotPassword = [
  body('email').isEmail().normalizeEmail(),
  ValidationMiddleware.validate
];

const validateResetPassword = [
  param('token').notEmpty().isLength({ min: 20, max: 200 }),
  body('newPassword').isLength({ min: 8, max: 100 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/),
  ValidationMiddleware.validate
];

const validateChangePassword = [
  body('currentPassword').notEmpty(),
  body('newPassword').isLength({ min: 8, max: 100 })
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .custom((value, { req }) => value !== req.body.currentPassword),
  ValidationMiddleware.validate
];

const validateRefreshToken = [
  body('token').notEmpty().isLength({ min: 50, max: 500 }),
  ValidationMiddleware.validate
];

const validateAdminPin = [
  body('pin').notEmpty().isLength({ min: 4, max: 6 }).isNumeric(),
  ValidationMiddleware.validate
];

// ==================== TEMPORARY TEST ROUTES (Development Only) ====================

if (process.env.NODE_ENV === 'development') {
  router.post('/test-login', (req, res) => {
    res.json({ 
      success: true, 
      message: 'Test route is working!',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV
    });
  });
}

// ==================== PUBLIC ROUTES ====================

router.post('/register', authLimiter, ValidationMiddleware.auth.register, authController.register);
router.post('/login', authLimiter, ValidationMiddleware.auth.login, authController.login);
router.post('/signup', signupLimiter, validateSignup, authController.signupWithOrg);
router.post('/forgot-password', authLimiter, validateForgotPassword, authController.forgotPassword);
router.post('/reset-password/:token', authLimiter, validateResetPassword, authController.resetPassword);

// // POST /api/auth/forgot-password
// router.post('/forgot-password', 
//   rateLimit({ windowMs: 15 * 60 * 1000, max: 3 }), // 3 attempts per 15 minutes
//   body('email').isEmail().normalizeEmail(),
//   authController.forgotPassword
// );

// // POST /api/auth/reset-password/:token
// router.post('/reset-password/:token',
//   body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
//   authController.resetPassword
// );

// ==================== PROTECTED ROUTES ====================

router.get('/me', protect, authController.getMe);
router.post('/logout', protect, authController.logout);
router.post('/change-password', protect, validateChangePassword, authController.changePassword);
router.post('/refresh-token', strictLimiter, validateRefreshToken, authController.refreshToken);

// ==================== ADMIN ROUTES ====================

router.get('/check-member-limit', protect, roleCheck('admin'), authController.checkMemberLimit);
router.post('/verify-admin-pin', protect, roleCheck('admin'), authLimiter, validateAdminPin, authController.verifyAdminPin);

module.exports = router;