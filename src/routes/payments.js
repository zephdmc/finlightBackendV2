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

// ==================== GET ROUTES ====================

// Public routes
router.get('/public/summary', paymentController.getPublicSummary);
router.get('/public/income', paymentController.getPublicIncome);

// User payment routes
router.get('/pending', paymentController.getPendingPayments);
router.get('/outstanding', paymentController.getOutstandingPayments);
router.get('/', paymentController.getUserPayments);

// Admin routes
router.get('/all', roleCheck('admin'), ValidationMiddleware.pagination, paymentController.getAllPayments);
router.get('/summary', roleCheck('admin'), paymentController.getPaymentSummary);
router.get('/stats', roleCheck('admin'), paymentController.getPaymentStats);

// ==================== POST ROUTES ====================
router.post('/admin-direct', roleCheck('admin'), adminPaymentLimiter, ValidationMiddleware.payment.adminDirect, paymentController.createAdminDirectPayment);
router.post('/member-payment', [
  body('type').isIn(['registration', 'dues', 'fine']),
  body('amount').isFloat({ min: 0.01, max: 10000000 }),
  body('description').optional().trim().isLength({ max: 500 })
], ValidationMiddleware.validate, paymentController.createMemberPayment);
router.post('/', roleCheck('admin'), adminPaymentLimiter, ValidationMiddleware.payment.create, paymentController.createPayment);
router.post('/bulk', roleCheck('admin'), adminPaymentLimiter, [
  body('payments').isArray({ min: 1, max: 100 }),
  body('payments.*.userId').isMongoId(),
  body('payments.*.type').isIn(['registration', 'dues', 'fine']),
  body('payments.*.amount').isFloat({ min: 0.01, max: 10000000 }),
  body('payments.*.dueDate').optional().isISO8601()
], ValidationMiddleware.validate, paymentController.processBulkPayments);

// ==================== PUT ROUTES ====================
router.put('/:id/mark-paid', roleCheck('admin'), ValidationMiddleware.idParam, paymentController.markFineAsPaid);
router.put('/:id', roleCheck('admin'), ValidationMiddleware.idParam, [
  body('amount').optional().isFloat({ min: 0.01, max: 10000000 }),
  body('dueDate').optional().isISO8601(),
  body('description').optional().trim().isLength({ max: 500 }),
  body('status').optional().isIn(['paid', 'unpaid', 'pending'])
], ValidationMiddleware.validate, paymentController.updatePayment);

// ==================== DELETE ROUTES ====================
router.delete('/:id', roleCheck('admin'), ValidationMiddleware.idParam, paymentController.deletePayment);

// ==================== GENERIC ID ROUTE (MUST BE LAST!) ====================
router.get('/:id', ValidationMiddleware.idParam, paymentController.getPaymentById);

module.exports = router;