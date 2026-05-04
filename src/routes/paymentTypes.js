const express = require('express');
const router = express.Router();
const paymentTypeController = require('../controllers/PaymentTypeController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');

// Import body for custom validation rules
const { body } = require('express-validator');

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/payment-types
 * @desc    Get all payment types
 * @access  Private
 */
router.get(
  '/',
  ValidationMiddleware.pagination,
  paymentTypeController.getAllPaymentTypes
);

/**
 * @route   GET /api/payment-types/active
 * @desc    Get all active payment types
 * @access  Private
 */
router.get(
  '/active',
  paymentTypeController.getActivePaymentTypes
);

/**
 * @route   GET /api/payment-types/mandatory
 * @desc    Get mandatory payment types
 * @access  Private
 */
router.get(
  '/mandatory',
  paymentTypeController.getMandatoryPaymentTypes
);

/**
 * @route   GET /api/payment-types/optional
 * @desc    Get optional payment types
 * @access  Private
 */
router.get(
  '/optional',
  paymentTypeController.getOptionalPaymentTypes
);

/**
 * @route   GET /api/payment-types/frequency/:frequency
 * @desc    Get payment types by frequency
 * @access  Private
 */
router.get(
  '/frequency/:frequency',
  paymentTypeController.getPaymentTypesByFrequency  // Make sure this exists in your controller
);

/**
 * @route   GET /api/payment-types/stats
 * @desc    Get payment type statistics (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/stats',
  roleCheck('admin'),
  paymentTypeController.getPaymentTypeStats
);

/**
 * @route   GET /api/payment-types/summary
 * @desc    Get payment type summary for dashboard (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/summary',
  roleCheck('admin'),
  paymentTypeController.getPaymentTypeSummary
);

/**
 * @route   GET /api/payment-types/export
 * @desc    Export payment types to CSV (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/export',
  roleCheck('admin'),
  paymentTypeController.exportPaymentTypes
);

/**
 * @route   GET /api/payment-types/:id
 * @desc    Get single payment type by ID
 * @access  Private
 */
router.get(
  '/:id',
  ValidationMiddleware.idParam,
  paymentTypeController.getPaymentType
);

/**
 * @route   GET /api/payment-types/:id/payments
 * @desc    Get payments by payment type (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/:id/payments',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.pagination,
  paymentTypeController.getPaymentsByType
);

/**
 * @route   GET /api/payment-types/:id/unpaid-members
 * @desc    Get members with unpaid payments for a specific type (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/:id/unpaid-members',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentTypeController.getUnpaidMembersByType
);

/**
 * @route   GET /api/payment-types/:id/report
 * @desc    Get payment type usage report (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/:id/report',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentTypeController.getPaymentTypeReport
);

/**
 * @route   POST /api/payment-types
 * @desc    Create new payment type (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/',
  roleCheck('admin'),
  [
    body('name')
      .notEmpty()
      .withMessage('Payment type name is required')
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Name must be between 2 and 100 characters'),
    body('type')
      .notEmpty()
      .withMessage('Payment type category is required')
      .isIn(['dues', 'leavy', 'registration', 'monthly_dues', 'wedding_dues', 'charity_dues'])
      .withMessage('Invalid category type'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description cannot exceed 500 characters'),
    body('amount')
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be greater than 0'),
    body('is_mandatory')
      .optional()
      .isBoolean()
      .withMessage('is_mandatory must be a boolean'),
    body('frequency')
      .optional()
      .isIn(['one-time', 'monthly', 'quarterly', 'yearly'])
      .withMessage('Invalid frequency type')
  ],
  ValidationMiddleware.validate,
  paymentTypeController.createPaymentType
);

/**
 * @route   POST /api/payment-types/bulk
 * @desc    Create multiple payment types (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/bulk',
  roleCheck('admin'),
  [
    body('paymentTypes')
      .isArray()
      .withMessage('paymentTypes must be an array')
      .notEmpty()
      .withMessage('paymentTypes array cannot be empty')
  ],
  ValidationMiddleware.validate,
  paymentTypeController.createBulkPaymentTypes
);

/**
 * @route   POST /api/payment-types/:id/generate-payments
 * @desc    Generate recurring payments from a payment type (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/:id/generate-payments',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentTypeController.generateRecurringPayments
);

/**
 * @route   PUT /api/payment-types/:id
 * @desc    Update payment type (Admin only)
 * @access  Private/Admin
 */
router.put(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  [
    body('name')
      .optional()
      .trim()
      .isLength({ min: 2, max: 100 })
      .withMessage('Name must be between 2 and 100 characters'),
    body('type')
      .optional()
      .isIn(['dues', 'leavy', 'registration', 'monthly_dues', 'wedding_dues', 'charity_dues'])
      .withMessage('Invalid category type'),
    body('description')
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage('Description cannot exceed 500 characters'),
    body('amount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be greater than 0'),
    body('is_mandatory')
      .optional()
      .isBoolean()
      .withMessage('is_mandatory must be a boolean'),
    body('frequency')
      .optional()
      .isIn(['one-time', 'monthly', 'quarterly', 'yearly'])
      .withMessage('Invalid frequency type'),
    body('isActive')
      .optional()
      .isBoolean()
      .withMessage('isActive must be a boolean')
  ],
  ValidationMiddleware.validate,
  paymentTypeController.updatePaymentType
);

/**
 * @route   PATCH /api/payment-types/:id/status
 * @desc    Toggle payment type active status (Admin only)
 * @access  Private/Admin
 */
router.patch(
  '/:id/status',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  [
    body('isActive')
      .isBoolean()
      .withMessage('isActive must be a boolean')
  ],
  ValidationMiddleware.validate,
  paymentTypeController.togglePaymentTypeStatus
);

/**
 * @route   DELETE /api/payment-types/:id
 * @desc    Delete payment type (Admin only)
 * @access  Private/Admin
 */
router.delete(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentTypeController.deletePaymentType
);

module.exports = router;