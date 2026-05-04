const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');

// Import body for any custom validation (if needed in future)
const { body } = require('express-validator');

// All routes require authentication
router.use(protect);

/**
 * @route   GET /api/transactions/income/public
 * @desc    Get all income records for public/member viewing (Read-only)
 * @access  Private (Authenticated users can view)
 */
router.get(
  '/income/public',
  ValidationMiddleware.pagination,
  transactionController.getAllIncomesPublic
);

/**
 * @route   GET /api/transactions/expenditure/public
 * @desc    Get all expenditure records for public/member viewing (Read-only)
 * @access  Private (Authenticated users can view)
 */
router.get(
  '/expenditure/public',
  ValidationMiddleware.pagination,
  transactionController.getAllExpendituresPublic
);

/**
 * @route   POST /api/transactions/income
 * @desc    Record new income (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/income',
  roleCheck('admin'),
  ValidationMiddleware.transaction.income,
  transactionController.recordIncome
);

/**
 * @route   POST /api/transactions/expenditure
 * @desc    Record new expenditure (Admin only)
 * @access  Private/Admin
 */
router.post(
  '/expenditure',
  roleCheck('admin'),
  ValidationMiddleware.transaction.expenditure,
  transactionController.recordExpenditure
);

/**
 * @route   GET /api/transactions/income
 * @desc    Get all income records (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/income',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  transactionController.getAllIncomes
);

/**
 * @route   GET /api/transactions/expenditure
 * @desc    Get all expenditure records (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/expenditure',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  transactionController.getAllExpenditures
);

/**
 * @route   GET /api/transactions/summary
 * @desc    Get transaction summary for dashboard
 * @access  Private
 */
router.get(
  '/summary',
  transactionController.getTransactionSummary
);

/**
 * @route   GET /api/transactions/income/:id
 * @desc    Get single income record (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/income/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  transactionController.getIncomeById
);

/**
 * @route   GET /api/transactions/expenditure/:id
 * @desc    Get single expenditure record (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/expenditure/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  transactionController.getExpenditureById
);

/**
 * @route   PUT /api/transactions/income/:id
 * @desc    Update income record (Admin only)
 * @access  Private/Admin
 */
router.put(
  '/income/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.transaction.updateIncome,
  transactionController.updateIncome
);

/**
 * @route   PUT /api/transactions/expenditure/:id
 * @desc    Update expenditure record (Admin only)
 * @access  Private/Admin
 */
router.put(
  '/expenditure/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.transaction.updateExpenditure,
  transactionController.updateExpenditure
);

/**
 * @route   DELETE /api/transactions/income/:id
 * @desc    Delete income record (Admin only)
 * @access  Private/Admin
 */
router.delete(
  '/income/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  transactionController.deleteIncome
);

/**
 * @route   DELETE /api/transactions/expenditure/:id
 * @desc    Delete expenditure record (Admin only)
 * @access  Private/Admin
 */
router.delete(
  '/expenditure/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  transactionController.deleteExpenditure
);

/**
 * @route   GET /api/transactions/recent
 * @desc    Get recent transactions (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/recent',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const { limit = 10 } = req.query;
      const Income = require('../models/Income');
      const Expenditure = require('../models/Expenditure');
      
      const [incomes, expenditures] = await Promise.all([
        Income.find()
          .sort({ createdAt: -1 })
          .limit(parseInt(limit))
          .populate('createdBy', 'name'),
        Expenditure.find()
          .sort({ createdAt: -1 })
          .limit(parseInt(limit))
          .populate('createdBy', 'name')
      ]);
      
      const transactions = [
        ...incomes.map(inc => ({
          id: inc._id,
          type: 'income',
          amount: inc.amount,
          description: inc.description,
          reference: inc.source,
          createdBy: inc.createdBy?.name || 'System',
          createdAt: inc.createdAt
        })),
        ...expenditures.map(exp => ({
          id: exp._id,
          type: 'expenditure',
          amount: exp.amount,
          description: exp.description,
          reference: exp.purpose,
          createdBy: exp.createdBy?.name || 'System',
          createdAt: exp.createdAt
        }))
      ];
      
      transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      
      res.status(200).json({
        success: true,
        data: transactions.slice(0, parseInt(limit))
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/balance
 * @desc    Get current balance (Admin only)
 * @access  Private/Admin
 */
router.get(
  '/balance',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const Income = require('../models/Income');
      const Expenditure = require('../models/Expenditure');
      
      const [totalIncome, totalExpenditure] = await Promise.all([
        Income.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }]),
        Expenditure.aggregate([{ $group: { _id: null, total: { $sum: '$amount' } } }])
      ]);
      
      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      
      res.status(200).json({
        success: true,
        data: {
          balance: income - expenditure,
          income,
          expenditure,
          lastUpdated: new Date()
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;