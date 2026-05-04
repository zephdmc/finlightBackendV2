const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const Payment = require('../models/Payment');  // Add this line
// const User = require('../models/User');        // Add this if you use it elsewhere
// Import body for custom validation rules
const { body } = require('express-validator');

// All routes require authentication
router.use(protect);
/**
 * @route   GET /api/payments/public/summary
 * @desc    Get public payment summary for members (total collected, counts)
 * @access  Private (Authenticated users)
 */
router.get(
  '/public/summary',
  protect,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      
      // Get total paid amount across all members
      const totalPaidResult = await Payment.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      
      // Get total outstanding amount
      const totalOutstandingResult = await Payment.aggregate([
        { $match: { status: 'unpaid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      
      // Get payment counts by type
      const paymentCounts = await Payment.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: '$type', count: { $sum: 1 }, total: { $sum: '$amount' } } }
      ]);
      
      // Get monthly payment totals (last 12 months)
      const twelveMonthsAgo = new Date();
      twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
      
      const monthlyPayments = await Payment.aggregate([
        { 
          $match: { 
            status: 'paid',
            paidAt: { $gte: twelveMonthsAgo }
          } 
        },
        {
          $group: {
            _id: {
              year: { $year: '$paidAt' },
              month: { $month: '$paidAt' }
            },
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } }
      ]);
      
      res.status(200).json({
        success: true,
        data: {
          totalCollected: totalPaidResult[0]?.total || 0,
          totalOutstanding: totalOutstandingResult[0]?.total || 0,
          paymentCounts: paymentCounts,
          monthlyTrend: monthlyPayments,
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);



/**
 * @route   POST /api/payments/initialize
 * @desc    Initialize a payment with Paystack
 * @access  Private
 */
router.post(
  '/initialize',
  ValidationMiddleware.payment.initialize,
  paymentController.initializePayment
);

// @route   POST /api/payments/admin-direct
// @desc    Create direct payment (Admin only - no Paystack)
// @access  Private/Admin
router.post(
    '/admin-direct',
    roleCheck('admin'),
    paymentController.createAdminDirectPayment
  );

/**
 * @route   GET /api/payments/pending
 * @desc    Get user's pending payments (payment types not yet paid)
 * @access  Private
 */
router.get(
  '/pending',
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getPendingPayments(req.user.id);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

// In paymentRoutes.js, add this route
/**
 * @route   POST /api/payments/member-payment
 * @desc    Create payment for member (for Paystack flow)
 * @access  Private
 */
router.post('/member-payment', protect, paymentController.createMemberPayment);
// In paymentRoutes.js
// router.get('/outstanding', protect, paymentController.getOutstandingPayments);
/**
 * @route   GET /api/payments/public/income
 * @desc    Get all paid payments as income records for members (public view)
 * @access  Private (Authenticated users can view)
 */
router.get(
  '/public/income',
  protect,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      
      // Get all paid payments with user and payment type info
      const payments = await Payment.find({ status: 'paid' })
        .populate('user', 'name')
        .populate('paymentTypeId', 'name')  // Fix: Use paymentTypeId instead of paymentType
        .sort({ paidAt: -1 })
        .limit(200);
      
      // Format as income records
      const incomeRecords = payments.map(payment => {
        // Get payment type name from populated paymentTypeId or fallback to type field
        let source = payment.paymentTypeId?.name || payment.type || 'Member Payment';
        // Capitalize first letter of each word for source
        source = source.split(' ').map(word => 
          word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        ).join(' ');
        
        let description = payment.description || '';
        if (!description) {
          description = `${source} payment from ${payment.user?.name || 'Member'}`;
        }
        
        return {
          _id: payment._id,
          amount: payment.amount,
          description: description,
          source: source,
          date: payment.paidAt || payment.createdAt,
          type: 'member_payment',
          memberName: payment.user?.name || 'Member',
          paymentType: source
        };
      });
      
      // Get summary totals
      const totalCollected = payments.reduce((sum, p) => sum + (p.amount || 0), 0);
      
      res.status(200).json({
        success: true,
        data: {
          records: incomeRecords,
          summary: {
            totalCollected,
            totalCount: payments.length,
            lastUpdated: new Date()
          }
        }
      });
    } catch (error) {
      console.error('Error in /public/income:', error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/verify/:reference
 * @desc    Verify payment status
 * @access  Private
 */
router.get(
  '/verify/:reference',
  ValidationMiddleware.payment.verify,
  paymentController.verifyPayment
);

/**
 * @route   GET /api/payments
 * @desc    Get current user's payments
 * @access  Private
 */
router.get(
  '/',
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getUserPayments(req.user.id, req.query);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

// @desc    Create payment for member (no admin required)
// @route   POST /api/payments/member-payment
// @access  Private
router.post('/member-payment', protect, async (req, res, next) => {
  try {
    const { type, amount, description, paymentTypeId } = req.body;
    const userId = req.user.id;
    
    console.log('Member payment creation request:', { userId, type, amount, paymentTypeId });
    
    // Validate required fields
    if (!type || !amount || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Type and valid amount are required'
      });
    }
    
    // Create payment with 'pending' status
    const payment = await Payment.create({
      user: userId,
      type: type,
      amount: amount,
      description: description || `${type} payment`,
      paymentTypeId: paymentTypeId || null,
      status: 'pending',
      transactionReference: `PENDING-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    });
    
    console.log('Payment created successfully:', payment._id);
    
    res.status(201).json({
      success: true,
      data: payment,
      message: 'Payment created successfully'
    });
  } catch (error) {
    console.error('Member payment creation error:', error);
    next(error);
  }
});

/**
 * @route   GET /api/payments/outstanding
 * @desc    Get user's outstanding payments
 * @access  Private
 */
router.get(
  '/outstanding',
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getOutstandingPayments(req.user.id);
      
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }
);

// Mark a fine as paid (Admin only)
router.put('/:id/mark-paid', protect, roleCheck('admin'), paymentController.markFineAsPaid);
/**
 * @route   POST /api/payments
 * @desc    Create a new payment (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/',
  roleCheck('admin'),
  ValidationMiddleware.payment.create,
  paymentController.createPayment
);

/**
 * @route   POST /api/payments/bulk
 * @desc    Create multiple payments (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/bulk',
  roleCheck('admin'),
  [
    body('payments')
      .isArray()
      .withMessage('Payments must be an array')
      .notEmpty()
      .withMessage('Payments array cannot be empty'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.processBulkPayments(req.body.payments);
      
      res.status(201).json({
        success: true,
        data: result,
        message: `Processed ${result.successful.length} successful, ${result.failed.length} failed`
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/payments/all
 * @desc    Get all payments (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/all',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getAllPayments(req.query);
      
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
 * @route   GET /api/payments/summary
 * @desc    Get payment summary for reporting (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/summary',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const paymentService = require('../services/paymentService');
      const result = await paymentService.getPaymentSummary(req.query);
      
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
 * @route   GET /api/payments/:id
 * @desc    Get single payment by ID
 * @access  Private
 */
router.get(
  '/:id',
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      const payment = await Payment.findById(req.params.id)
        .populate('user', 'name email');
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      // Check authorization
      if (req.user.role !== 'admin' && payment.user._id.toString() !== req.user.id) {
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this payment'
        });
      }
      
      res.status(200).json({
        success: true,
        data: payment
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /api/payments/:id
 * @desc    Update payment (Admin only)
 * @access  Private/Admin
 */
router.put(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  [
    body('amount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Amount must be greater than 0'),
    body('dueDate')
      .optional()
      .isISO8601()
      .withMessage('Invalid date format'),
  ],
  ValidationMiddleware.validate,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      const { amount, dueDate, description } = req.body;
      
      const payment = await Payment.findById(req.params.id);
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      if (payment.status === 'paid') {
        return res.status(400).json({
          success: false,
          message: 'Cannot update a paid payment'
        });
      }
      
      if (amount) payment.amount = amount;
      if (dueDate) payment.dueDate = dueDate;
      if (description) payment.description = description;
      
      await payment.save();
      
      res.status(200).json({
        success: true,
        data: payment,
        message: 'Payment updated successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /api/payments/:id
 * @desc    Delete payment (Admin only)
 * @access  Private/Admin
 */
router.delete(
  '/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Payment = require('../models/Payment');
      const payment = await Payment.findById(req.params.id);
      
      if (!payment) {
        return res.status(404).json({
          success: false,
          message: 'Payment not found'
        });
      }
      
      if (payment.status === 'paid') {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete a paid payment'
        });
      }
      
      await payment.deleteOne();
      
      res.status(200).json({
        success: true,
        message: 'Payment deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/payments/webhook/paystack
 * @desc    Paystack webhook handler
 * @access  Public (but should verify signature)
 */
router.post(
  '/webhook/paystack',
  express.raw({ type: 'application/json' }),
  async (req, res, next) => {
    try {
      const paystackConfig = require('../config/paystack');
      const signature = req.headers['x-paystack-signature'];
      const payload = JSON.stringify(req.body);
      
      // Verify webhook signature
      if (!paystackConfig.verifyWebhookSignature(signature, payload)) {
        return res.status(401).json({
          success: false,
          message: 'Invalid webhook signature'
        });
      }
      
      const paymentService = require('../services/paymentService');
      await paymentService.handleWebhook(req.body);
      
      res.status(200).json({ success: true });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;