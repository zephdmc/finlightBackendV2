const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentTypeController = require('../controllers/PaymentTypeController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const { body, param } = require('express-validator');

// ==================== RATE LIMITING ====================
const readLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { success: false, message: 'Too many read requests' },
});

const adminWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { success: false, message: 'Too many write operations' }
});

const bulkOperationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { success: false, message: 'Bulk operation limit reached' }
});

// All routes require authentication
router.use(protect);
router.use(readLimiter);

// ==================== PUBLIC READ ROUTES ====================

router.get('/', ValidationMiddleware.pagination, paymentTypeController.getAllPaymentTypes);
router.get('/active', paymentTypeController.getActivePaymentTypes);
router.get('/mandatory', paymentTypeController.getMandatoryPaymentTypes);
router.get('/optional', paymentTypeController.getOptionalPaymentTypes);

router.get('/frequency/:frequency',
  param('frequency').isIn(['one-time', 'monthly', 'quarterly', 'yearly']),
  ValidationMiddleware.validate,
  paymentTypeController.getPaymentTypesByFrequency
);

// ==================== ADMIN STATISTICS ROUTES ====================

router.get('/stats', roleCheck('admin'), paymentTypeController.getPaymentTypeStats);
router.get('/summary', roleCheck('admin'), paymentTypeController.getPaymentTypeSummary);
router.get('/export', roleCheck('admin'), paymentTypeController.exportPaymentTypes);

// ==================== SINGLE PAYMENT TYPE ROUTES ====================

router.get('/:id', ValidationMiddleware.idParam, paymentTypeController.getPaymentType);
router.get('/:id/payments', 
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.pagination,
  paymentTypeController.getPaymentsByType
);
router.get('/:id/unpaid-members',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentTypeController.getUnpaidMembersByType
);
router.get('/:id/report',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentTypeController.getPaymentTypeReport
);

// ==================== ADMIN WRITE ROUTES ====================

// Create payment type - REMOVED sanitizeAll and preventNoSQLInjection
router.post('/',
  roleCheck('admin'),
  adminWriteLimiter,
  [
    body('name').notEmpty().trim().isLength({ min: 2, max: 100 })
      .matches(/^[a-zA-Z0-9\s-]+$/),
    body('type').isIn(['dues', 'leavy', 'registration', 'monthly_dues', 'wedding_dues', 'charity_dues']),
    body('description').optional().trim().isLength({ max: 500 }),
    body('amount').isFloat({ min: 0.01, max: 10000000 }),
    body('is_mandatory').optional().isBoolean(),
    body('frequency').optional().isIn(['one-time', 'monthly', 'quarterly', 'yearly']),
    body('duration_value').optional().isInt({ min: 1, max: 365 }),
    body('duration_unit').optional().isIn(['days', 'weeks', 'months', 'years'])
  ],
  ValidationMiddleware.validate,
  paymentTypeController.createPaymentType
);

// Bulk create - REMOVED sanitizeAll
router.post('/bulk',
  roleCheck('admin'),
  bulkOperationLimiter,
  [
    body('paymentTypes').isArray({ min: 1, max: 20 }),
    body('paymentTypes.*.name').notEmpty().trim().isLength({ min: 2, max: 100 }),
    body('paymentTypes.*.type').isIn(['dues', 'leavy', 'registration', 'monthly_dues', 'wedding_dues', 'charity_dues']),
    body('paymentTypes.*.amount').isFloat({ min: 0.01, max: 10000000 }),
    body('paymentTypes.*.frequency').optional().isIn(['one-time', 'monthly', 'quarterly', 'yearly'])
  ],
  ValidationMiddleware.validate,
  paymentTypeController.createBulkPaymentTypes
);

// Generate recurring payments
router.post('/:id/generate-payments',
  roleCheck('admin'),
  adminWriteLimiter,
  ValidationMiddleware.idParam,
  [
    body('startDate').optional().isISO8601().toDate(),
    body('endDate').optional().isISO8601().toDate(),
    body('memberIds').optional().isArray(),
    body('memberIds.*').optional().isMongoId()
  ],
  ValidationMiddleware.validate,
  paymentTypeController.generateRecurringPayments
);

// Update payment type - REMOVED sanitizeAll
router.put('/:id',
  roleCheck('admin'),
  adminWriteLimiter,
  ValidationMiddleware.idParam,
  [
    body('name').optional().trim().isLength({ min: 2, max: 100 })
      .matches(/^[a-zA-Z0-9\s-]+$/),
    body('type').optional().isIn(['dues', 'leavy', 'registration', 'monthly_dues', 'wedding_dues', 'charity_dues']),
    body('description').optional().trim().isLength({ max: 500 }),
    body('amount').optional().isFloat({ min: 0.01, max: 10000000 }),
    body('is_mandatory').optional().isBoolean(),
    body('frequency').optional().isIn(['one-time', 'monthly', 'quarterly', 'yearly']),
    body('isActive').optional().isBoolean()
  ],
  ValidationMiddleware.validate,
  paymentTypeController.updatePaymentType
);

// Toggle status
router.patch('/:id/status',
  roleCheck('admin'),
  adminWriteLimiter,
  ValidationMiddleware.idParam,
  [body('isActive').isBoolean()],
  ValidationMiddleware.validate,
  paymentTypeController.togglePaymentTypeStatus
);

// Delete payment type (with check in controller)
router.delete('/:id',
  roleCheck('admin'),
  adminWriteLimiter,
  ValidationMiddleware.idParam,
  paymentTypeController.deletePaymentType
);

module.exports = router;