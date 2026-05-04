const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');

// Import body and param in case we need custom validation
const { body, param } = require('express-validator');

// All routes require authentication
router.use(protect);


/**
 * @route   GET /api/reports/summary
 * @desc    Get overall financial summary
 * @access  Private (Admin gets full, Members get limited)
 */
router.get(
  '/summary',
  async (req, res, next) => {
    try {
      if (req.user.role === 'admin') {
        await reportController.getSummary(req, res, next);
      } else {
        // Members get limited view
        const paymentService = require('../services/paymentService');
        const summary = await paymentService.getPaymentSummary();
        
        res.status(200).json({
          success: true,
          data: {
            totalBalance: summary.totalRevenue || 0,
            totalMembers: await require('../models/User').countDocuments({ role: 'member' }),
            message: 'Limited view for members'
          }
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/reports/monthly-summary
 * @desc    Get monthly financial summary for charts
 * @access  Private/Admin
 */
router.get(
  '/monthly-summary',
  roleCheck('admin'),
  ValidationMiddleware.report.monthly,
  reportController.getMonthlySummary
);

/**
 * @route   GET /api/reports/paid-members
 * @desc    Get list of members who have paid registration
 * @access  Private/Admin
 */
router.get(
  '/paid-members',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getPaidMembers
);

/**
 * @route   GET /api/reports/outstanding
 * @desc    Get all outstanding payments
 * @access  Private/Admin
 */
router.get(
  '/outstanding',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getOutstandingPayments
);

/**
 * @route   GET /api/reports/income
 * @desc    Get income report
 * @access  Private/Admin
 */
router.get(
  '/income',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getIncomeReport
);

/**
 * @route   GET /api/reports/expenditure
 * @desc    Get expenditure report
 * @access  Private/Admin
 */
router.get(
  '/expenditure',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  reportController.getExpenditureReport
);

/**
 * @route   GET /api/reports/member/:userId
 * @desc    Get payment report for specific member
 * @access  Private (Admin or member themselves)
 */
router.get(
  '/member/:userId',
  ValidationMiddleware.idParam,
  reportController.getMemberPaymentReport
);

/**
 * @route   GET /api/reports/export/:type
 * @desc    Export report as CSV/Excel
 * @access  Private/Admin
 */
router.get(
  '/export/:type',
  roleCheck('admin'),
  ValidationMiddleware.report.export,
  reportController.exportReport
);

/**
 * @route   GET /api/reports/financial-overview
 * @desc    Get detailed financial overview with trends
 * @access  Private/Admin
 */
router.get(
  '/financial-overview',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const { period = 'month' } = req.query;
      const Income = require('../models/Income');
      const Expenditure = require('../models/Expenditure');
      
      let startDate;
      const endDate = new Date();
      
      switch(period) {
        case 'week':
          startDate = new Date(endDate);
          startDate.setDate(endDate.getDate() - 7);
          break;
        case 'month':
          startDate = new Date(endDate);
          startDate.setMonth(endDate.getMonth() - 1);
          break;
        case 'year':
          startDate = new Date(endDate);
          startDate.setFullYear(endDate.getFullYear() - 1);
          break;
        default:
          startDate = new Date(endDate);
          startDate.setMonth(endDate.getMonth() - 1);
      }
      
      const [incomeData, expenditureData] = await Promise.all([
        Income.aggregate([
          { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ]),
        Expenditure.aggregate([
          { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
          { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
        ])
      ]);
      
      // Get top income sources
      const topSources = await Income.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: '$source', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
        { $limit: 5 }
      ]);
      
      // Get top expenditure purposes
      const topPurposes = await Expenditure.aggregate([
        { $match: { createdAt: { $gte: startDate, $lte: endDate } } },
        { $group: { _id: '$purpose', total: { $sum: '$amount' } } },
        { $sort: { total: -1 } },
        { $limit: 5 }
      ]);
      
      res.status(200).json({
        success: true,
        data: {
          period,
          dateRange: { startDate, endDate },
          summary: {
            totalIncome: incomeData[0]?.total || 0,
            totalExpenditure: expenditureData[0]?.total || 0,
            netFlow: (incomeData[0]?.total || 0) - (expenditureData[0]?.total || 0),
            transactionCount: {
              income: incomeData[0]?.count || 0,
              expenditure: expenditureData[0]?.count || 0
            }
          },
          topSources,
          topPurposes
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/reports/member-performance
 * @desc    Get member payment performance metrics (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/member-performance',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      const Payment = require('../models/Payment');
      
      const [totalMembers, paidMembers, outstandingTotals] = await Promise.all([
        User.countDocuments({ role: 'member' }),
        Payment.countDocuments({ type: 'registration', status: 'paid' }),
        Payment.aggregate([
          { $match: { status: 'unpaid' } },
          { $group: { _id: '$user', total: { $sum: '$amount' } } },
          { $sort: { total: -1 } },
          { $limit: 10 }
        ])
      ]);
      
      // Get members with highest outstanding
      const topOutstanding = await Promise.all(
        outstandingTotals.map(async (item) => {
          const user = await User.findById(item._id).select('name email');
          return {
            user,
            totalOutstanding: item.total
          };
        })
      );
      
      const paymentRate = totalMembers > 0 ? (paidMembers / totalMembers) * 100 : 0;
      
      res.status(200).json({
        success: true,
        data: {
          totalMembers,
          paidMembers,
          unpaidMembers: totalMembers - paidMembers,
          paymentRate: Math.round(paymentRate * 100) / 100,
          topOutstanding,
          registrationFee: 500
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;