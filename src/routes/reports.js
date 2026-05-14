const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const reportController = require('../controllers/reportController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const { query } = require('express-validator');

// ==================== RATE LIMITING ====================

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 70,
  message: { success: false, message: 'Too many report requests. Please try again later.' }
});

const heavyReportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 90,
  message: { success: false, message: 'Rate limit exceeded for this report type.' }
});

// ==================== AUTHORIZATION MIDDLEWARE ====================

const checkMemberReportAccess = async (req, res, next) => {
  try {
    const targetUserId = req.params.userId;
    
    if (!targetUserId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }
    
    if (req.user.role === 'admin') {
      return next();
    }
    
    if (req.user.id === targetUserId) {
      return next();
    }
    
    return res.status(403).json({
      success: false,
      message: 'Access denied. You can only view your own payment reports.'
    });
  } catch (error) {
    next(error);
  }
};

// All routes require authentication
router.use(protect);
router.use(reportLimiter);

// ==================== ROUTES ====================

// Financial summary (handles member vs admin in controller)
router.get('/summary', reportController.getSummary);

// Monthly summary for charts
router.get(
  '/monthly-summary',
  heavyReportLimiter,
  roleCheck('admin'),
  ValidationMiddleware.report.monthly,
  reportController.getMonthlySummary
);

// Paid members report
router.get(
  '/paid-members',
  heavyReportLimiter,
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getPaidMembers
);

// Outstanding payments report
router.get(
  '/outstanding',
  heavyReportLimiter,
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getOutstandingPayments
);

// Income report
router.get(
  '/income',
  heavyReportLimiter,
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getIncomeReport
);


// Expenditure report
router.get(
  '/expenditure',
  heavyReportLimiter,
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getExpenditureReport
);

// Member payment report (with IDOR protection)
router.get(
  '/member/:userId',
  ValidationMiddleware.idParam,
  checkMemberReportAccess,
  reportController.getMemberPaymentReport
);

// Export report as CSV
router.get(
  '/export/:type',
  heavyReportLimiter,
  roleCheck('admin'),
  ValidationMiddleware.report.export,
  reportController.exportReport
);

// Financial overview with trends
router.get(
  '/financial-overview',
  heavyReportLimiter,
  roleCheck('admin'),
  query('period').optional().isIn(['week', 'month', 'year']),
  ValidationMiddleware.validate,
  reportController.getFinancialOverview  // You'll need to add this to your controller
);

// Member payment performance metrics
router.get(
  '/member-performance',
  heavyReportLimiter,
  roleCheck('admin'),
  reportController.getMemberPerformance  // You'll need to add this to your controller
);

module.exports = router;