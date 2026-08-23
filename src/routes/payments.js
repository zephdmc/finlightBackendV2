const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const { body } = require('express-validator');

// ==================== RATE LIMITING ====================

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { success: false, message: 'Too many payment requests' }
});

const adminPaymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { success: false, message: 'Too many admin payment requests' }
});

// All routes require authentication
router.use(protect);
router.use(paymentLimiter);

// ============================================================
// IMPORTANT: Specific routes MUST come BEFORE generic /:id
// ============================================================

// ==================== GET ROUTES ====================

// Public routes
router.get('/public/summary', paymentController.getPublicSummary);
router.get('/public/income', paymentController.getPublicIncome);

// User payment routes - SPECIFIC BEFORE GENERIC
router.get('/pending', paymentController.getPendingPayments);
router.get('/outstanding', paymentController.getOutstandingPayments);
router.get('/current-period', paymentController.getCurrentPeriodPayments);
router.get('/periods', paymentController.getPaymentPeriods);
router.get('/', paymentController.getUserPayments);

// ============================================================
// NEW: DUES ROUTES (Hybrid Implementation)
// ============================================================

// Get dues summary for the logged-in member
router.get('/dues-summary', paymentController.getDuesSummary);

// Get a specific dues payment by ID
router.get('/dues-payment/:id', ValidationMiddleware.idParam, paymentController.getDuesPaymentById);

// ============================================================
// Admin routes
// ============================================================
router.get('/all', roleCheck('admin'), ValidationMiddleware.pagination, paymentController.getAllPayments);
router.get('/summary', roleCheck('admin'), paymentController.getPaymentSummary);
router.get('/stats', roleCheck('admin'), paymentController.getPaymentStats);

// ============================================================
// NEW: Admin Dues Routes
// ============================================================

// Admin: Create dues payments for a member (bulk months)
router.post(
  '/admin/create-dues',
  roleCheck('admin'),
  adminPaymentLimiter,
  [
    body('userId').isMongoId().withMessage('Valid user ID is required'),
    body('paymentTypeId').isMongoId().withMessage('Valid payment type ID is required'),
    body('months').isArray({ min: 1 }).withMessage('At least one month is required'),
    body('months.*').isString().matches(/^\d{4}-\d{2}$/).withMessage('Invalid month format. Use YYYY-MM'),
    body('name').optional().isString().trim().isLength({ min: 2, max: 100 }),
    body('type').optional().isIn(['dues', 'monthly_dues']),
    body('amount').optional().isFloat({ min: 0.01, max: 10000000 })
  ],
  ValidationMiddleware.validate,
  paymentController.adminCreateDuesPayment
);

// ==================== POST ROUTES ====================

router.post(
  '/admin-direct',
  roleCheck('admin'),
  adminPaymentLimiter,
  ValidationMiddleware.payment.adminDirect,
  paymentController.createAdminDirectPayment
);

router.post(
  '/member-payment',
  [
    body('type').isIn(['registration', 'dues', 'fine', 'monthly_dues', 'wedding_dues', 'charity_dues', 'leavy']),
    body('amount').isFloat({ min: 0.01, max: 10000000 }),
    body('description').optional().trim().isLength({ max: 500 }),
    // ============================================================
    // NEW: Hybrid dues fields
    // ============================================================
    body('months').optional().isArray().withMessage('Months must be an array'),
    body('months.*').optional().isString().matches(/^\d{4}-\d{2}$/).withMessage('Invalid month format. Use YYYY-MM'),
    body('monthCount').optional().isInt({ min: 1 }),
    body('monthlyPrice').optional().isFloat({ min: 0.01 }),
    // Legacy period fields
    body('periodStart').optional().isISO8601(),
    body('periodEnd').optional().isISO8601(),
    body('periodKey').optional().isString().trim()
  ],
  ValidationMiddleware.validate,
  paymentController.createMemberPayment
);

router.post(
  '/',
  roleCheck('admin'),
  adminPaymentLimiter,
  ValidationMiddleware.payment.create,
  paymentController.createPayment
);

router.post(
  '/bulk',
  roleCheck('admin'),
  adminPaymentLimiter,
  [
    body('payments').isArray({ min: 1, max: 100 }),
    body('payments.*.userId').isMongoId(),
    body('payments.*.type').isIn(['registration', 'dues', 'fine']),
    body('payments.*.amount').isFloat({ min: 0.01, max: 10000000 }),
    body('payments.*.dueDate').optional().isISO8601()
  ],
  ValidationMiddleware.validate,
  paymentController.processBulkPayments
);

router.post(
  '/record-partial',
  roleCheck('admin'),
  [
    body('paymentId').isMongoId(),
    body('amountPaid').isFloat({ min: 0.01, max: 10000000 }),
    body('reference').optional().trim(),
    body('notes').optional().trim().isLength({ max: 500 })
  ],
  ValidationMiddleware.validate,
  paymentController.recordPartialPayment
);

// ==================== PUT ROUTES ====================

router.put(
  '/:id/mark-paid',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentController.markFineAsPaid
);

router.put(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  [
    body('amount').optional().isFloat({ min: 0.01, max: 10000000 }),
    body('dueDate').optional().isISO8601(),
    body('description').optional().trim().isLength({ max: 500 }),
    body('status').optional().isIn(['paid', 'unpaid', 'pending']),
    // NEW: Hybrid dues fields
    body('months').optional().isArray(),
    body('months.*').optional().isString().matches(/^\d{4}-\d{2}$/).withMessage('Invalid month format. Use YYYY-MM'),
    body('monthCount').optional().isInt({ min: 1 }),
    body('monthlyPrice').optional().isFloat({ min: 0.01 }),
    // Legacy period fields
    body('periodStart').optional().isISO8601(),
    body('periodEnd').optional().isISO8601(),
    body('periodKey').optional().isString().trim()
  ],
  ValidationMiddleware.validate,
  paymentController.updatePayment
);

// ==================== DELETE ROUTES ====================

router.delete(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  paymentController.deletePayment
);

// ==================== GENERIC ID ROUTE (MUST BE LAST!) ====================
// IMPORTANT: This MUST be the LAST route for /:id
router.get('/:id', ValidationMiddleware.idParam, paymentController.getPaymentById);

module.exports = router;