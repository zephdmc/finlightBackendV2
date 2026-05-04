const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');

// Import body for custom validation rules
const { body } = require('express-validator');

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/users
 * @desc    Get all users
 * @access  Private
 */
router.get(
  '/',
  ValidationMiddleware.pagination,
  userController.getAllUsers
);

/**
 * @route   GET /api/users/stats
 * @desc    Get user statistics (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/stats',
  roleCheck('admin'),
  userController.getUserStats
);

/**
 * @route   POST /api/users/register
 * @desc    Register new member (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/register',
  roleCheck('admin'),
  ValidationMiddleware.user.create,
  userController.registerMember
);

/**
 * @route   POST /api/users/bulk-import
 * @desc    Bulk import members (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/bulk-import',
  roleCheck('admin'),
  [
    body('members')
      .isArray()
      .withMessage('Members must be an array')
      .notEmpty()
      .withMessage('Members array cannot be empty'),
  ],
  ValidationMiddleware.validate,
  userController.bulkImportMembers
);

/**
 * @route   GET /api/users/:id
 * @desc    Get user by ID
 * @access  Private (Admin or self)
 */
router.get(
  '/:id',
  ValidationMiddleware.idParam,
  userController.getUserById
);

/**
 * @route   PUT /api/users/:id
 * @desc    Update user
 * @access  Private (Admin or self)
 */
router.put(
  '/:id',
  ValidationMiddleware.idParam,
  ValidationMiddleware.user.update,
  userController.updateUser
);

/**
 * @route   DELETE /api/users/:id
 * @desc    Delete user (Admin only)
 * @access  Private/Admin
 */
router.delete(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  userController.deleteUser
);

/**
 * @route   POST /api/users/:id/reset-password
 * @desc    Reset user password (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/:id/reset-password',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.user.resetPassword,
  userController.resetPassword
);

/**
 * @route   GET /api/users/:id/payment-summary
 * @desc    Get member payment summary
 * @access  Private (Admin or self)
 */
router.get(
  '/:id/payment-summary',
  ValidationMiddleware.idParam,
  userController.getMemberPaymentSummary
);

/**
 * @route   GET /api/users/:id/transactions
 * @desc    Get user's transaction history
 * @access  Private (Admin or self)
 */
router.get(
  '/:id/transactions',
  ValidationMiddleware.idParam,
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { page = 1, limit = 20 } = req.query;
      
      // Check authorization
      if (req.user.role !== 'admin' && req.user.id !== id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view these transactions'
        });
      }
      
      const Payment = require('../models/Payment');
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [payments, total] = await Promise.all([
        Payment.find({ user: id })
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        Payment.countDocuments({ user: id })
      ]);
      
      const summary = {
        totalPaid: payments
          .filter(p => p.status === 'paid')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        totalOutstanding: payments
          .filter(p => p.status === 'unpaid')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        paidCount: payments.filter(p => p.status === 'paid').length,
        unpaidCount: payments.filter(p => p.status === 'unpaid').length
      };
      
      res.status(200).json({
        success: true,
        data: {
          payments,
          summary,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / parseInt(limit))
          }
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/users/:id/verify-registration
 * @desc    Manually verify registration payment (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/:id/verify-registration',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const User = require('../models/User');
      const Payment = require('../models/Payment');
      
      const user = await User.findById(id);
      
      if (!user) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      const registrationPayment = await Payment.findOne({
        user: id,
        type: 'registration'
      });
      
      if (!registrationPayment) {
        return res.status(404).json({
          success: false,
          message: 'Registration payment record not found'
        });
      }
      
      if (registrationPayment.status === 'paid') {
        return res.status(400).json({
          success: false,
          message: 'Registration already verified'
        });
      }
      
      // Manually verify registration
      registrationPayment.status = 'paid';
      registrationPayment.paidAt = new Date();
      await registrationPayment.save();
      
      user.hasPaidRegistration = true;
      await user.save();
      
      res.status(200).json({
        success: true,
        message: 'Registration verified successfully',
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            hasPaidRegistration: user.hasPaidRegistration
          },
          payment: registrationPayment
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/users/export/all
 * @desc    Export all members (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/export/all',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      const Payment = require('../models/Payment');
      
      const users = await User.find({ role: 'member' })
        .select('name email createdAt')
        .sort({ createdAt: -1 });
      
      const usersWithPayment = await Promise.all(
        users.map(async (user) => {
          const registration = await Payment.findOne({
            user: user._id,
            type: 'registration'
          });
          
          return {
            name: user.name,
            email: user.email,
            registeredAt: user.createdAt,
           
          };
        })
      );
      
      res.status(200).json({
        success: true,
        data: usersWithPayment,
        filename: `members_export_${Date.now()}.csv`
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;