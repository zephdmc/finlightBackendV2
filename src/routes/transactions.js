const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transactionController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const rateLimit = require('express-rate-limit');
const { body, param, query } = require('express-validator');

// ==================== SECURITY MIDDLEWARE ====================

// Transaction-specific rate limiting
const transactionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // 50 requests per 15 minutes
  message: {
    success: false,
    message: 'Too many transaction requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for write operations
const writeTransactionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 write operations per hour
  message: {
    success: false,
    message: 'Transaction creation rate limit exceeded. Please slow down.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Audit logging middleware for financial transactions
const auditTransactionAccess = (action, resourceType) => {
  return async (req, res, next) => {
    const originalEnd = res.end;
    const startTime = Date.now();
    const requestData = {
      method: req.method,
      url: req.originalUrl,
      body: action === 'CREATE' || action === 'UPDATE' ? 
        { ...req.body, password: undefined, sensitive: undefined } : 
        undefined,
      params: req.params,
      query: req.query
    };
    
    res.end = function(chunk, encoding) {
      const responseTime = Date.now() - startTime;
      
      setImmediate(() => {
        try {
          const AuditLog = require('../models/AuditLog');
          AuditLog.create({
            userId: req.user.id,
            userEmail: req.user.email,
            userRole: req.user.role,
            action: `TRANSACTION_${action}`,
            resourceType: resourceType,
            resourceId: req.params.id,
            details: requestData,
            ip: req.ip,
            userAgent: req.get('user-agent'),
            statusCode: res.statusCode,
            responseTime: responseTime,
            timestamp: new Date()
          }).catch(err => console.error('Audit log failed:', err));
        } catch (error) {
          console.error('Audit logging error:', error);
        }
      });
      
      originalEnd.call(this, chunk, encoding);
    };
    
    next();
  };
};

// Authorization middleware for transaction access
const checkTransactionAccess = async (req, res, next) => {
  try {
    // Admins have full access
    if (req.user.role === 'admin') {
      return next();
    }
    
    // Members can only access public endpoints
    const publicEndpoints = ['/income/public', '/expenditure/public', '/summary'];
    const isPublicEndpoint = publicEndpoints.some(endpoint => 
      req.originalUrl.includes(endpoint)
    );
    
    if (!isPublicEndpoint) {
      return res.status(403).json({
        success: false,
        message: 'Access denied. Members can only view public transaction data.'
      });
    }
    
    next();
  } catch (error) {
    console.error('Transaction access check error:', error);
    next(error);
  }
};

// Validation for limit parameter
const validateLimit = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100')
    .toInt(),
  ValidationMiddleware.validate
];

// All routes require authentication
router.use(protect);
router.use(transactionLimiter);
router.use(checkTransactionAccess); // Additional authorization layer

// ==================== PUBLIC (MEMBER) ROUTES ====================

/**
 * @route   GET /api/transactions/income/public
 * @desc    Get all income records for public/member viewing (Read-only)
 * @access  Private (Authenticated users can view)
 * @security Added organization scoping and limit validation
 */
router.get(
  '/income/public',
  validateLimit,
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const Income = require('../models/Income');
      
      // Add organization scoping for multi-tenant security
      const organizationFilter = req.user.organizationId ? 
        { organizationId: req.user.organizationId } : {};
      
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [incomes, total] = await Promise.all([
        Income.find(organizationFilter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .select('-__v'), // Exclude version field
        Income.countDocuments(organizationFilter)
      ]);
      
      res.status(200).json({
        success: true,
        data: incomes,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/expenditure/public
 * @desc    Get all expenditure records for public/member viewing (Read-only)
 * @access  Private (Authenticated users can view)
 * @security Added organization scoping and limit validation
 */
router.get(
  '/expenditure/public',
  validateLimit,
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20 } = req.query;
      const Expenditure = require('../models/Expenditure');
      
      // Add organization scoping for multi-tenant security
      const organizationFilter = req.user.organizationId ? 
        { organizationId: req.user.organizationId } : {};
      
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [expenditures, total] = await Promise.all([
        Expenditure.find(organizationFilter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .select('-__v'),
        Expenditure.countDocuments(organizationFilter)
      ]);
      
      res.status(200).json({
        success: true,
        data: expenditures,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

// ==================== ADMIN ROUTES ====================

/**
 * @route   POST /api/transactions/income
 * @desc    Record new income (Admin only)
 * @access  Private/Admin
 * @security Added audit logging and organization scoping
 */
router.post(
  '/income',
  writeTransactionLimiter,
  auditTransactionAccess('CREATE', 'INCOME'),
  roleCheck('admin'),
  ValidationMiddleware.transaction.income,
  async (req, res, next) => {
    try {
      // Add organization ID from authenticated user
      req.body.organizationId = req.user.organizationId;
      req.body.createdBy = req.user.id;
      
      // Forward to controller
      transactionController.recordIncome(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/transactions/expenditure
 * @desc    Record new expenditure (Admin only)
 * @access  Private/Admin
 * @security Added audit logging and organization scoping
 */
router.post(
  '/expenditure',
  writeTransactionLimiter,
  auditTransactionAccess('CREATE', 'EXPENDITURE'),
  roleCheck('admin'),
  ValidationMiddleware.transaction.expenditure,
  async (req, res, next) => {
    try {
      // Add organization ID from authenticated user
      req.body.organizationId = req.user.organizationId;
      req.body.createdBy = req.user.id;
      
      transactionController.recordExpenditure(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/income
 * @desc    Get all income records (Admin only)
 * @access  Private/Admin
 * @security Added organization scoping
 */
router.get(
  '/income',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, startDate, endDate } = req.query;
      const Income = require('../models/Income');
      
      // Build filter with organization scoping
      const filter = { organizationId: req.user.organizationId };
      
      // Add date range filter if provided
      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
      }
      
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [incomes, total] = await Promise.all([
        Income.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('createdBy', 'name email'),
        Income.countDocuments(filter)
      ]);
      
      res.status(200).json({
        success: true,
        data: incomes,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/expenditure
 * @desc    Get all expenditure records (Admin only)
 * @access  Private/Admin
 * @security Added organization scoping
 */
router.get(
  '/expenditure',
  roleCheck('admin'),
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, startDate, endDate } = req.query;
      const Expenditure = require('../models/Expenditure');
      
      // Build filter with organization scoping
      const filter = { organizationId: req.user.organizationId };
      
      // Add date range filter if provided
      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
      }
      
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      const [expenditures, total] = await Promise.all([
        Expenditure.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .populate('createdBy', 'name email'),
        Expenditure.countDocuments(filter)
      ]);
      
      res.status(200).json({
        success: true,
        data: expenditures,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/summary
 * @desc    Get transaction summary for dashboard
 * @access  Private
 * @security Added organization scoping and member restrictions
 */
router.get(
  '/summary',
  async (req, res, next) => {
    try {
      const Income = require('../models/Income');
      const Expenditure = require('../models/Expenditure');
      const Payment = require('../models/Payment');
      
      // Add organization scoping
      const organizationFilter = req.user.organizationId ? 
        { organizationId: req.user.organizationId } : {};
      
      // Members get limited summary, admins get full
      const isAdmin = req.user.role === 'admin';
      
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const summaryFilter = isAdmin ? organizationFilter : {
        ...organizationFilter,
        createdAt: { $gte: thirtyDaysAgo } // Members only see last 30 days
      };
      
      const [totalIncome, totalExpenditure, recentPayments] = await Promise.all([
        Income.aggregate([
          { $match: summaryFilter },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Expenditure.aggregate([
          { $match: summaryFilter },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Payment.find(organizationFilter)
          .sort({ createdAt: -1 })
          .limit(5)
          .select('amount type status createdAt')
      ]);
      
      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      
      res.status(200).json({
        success: true,
        data: {
          balance: income - expenditure,
          totalIncome: income,
          totalExpenditure: expenditure,
          recentPayments,
          isLimited: !isAdmin, // Indicate if view is limited
          ...(!isAdmin && { message: 'Showing last 30 days of data for members' })
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/income/:id
 * @desc    Get single income record (Admin only)
 * @access  Private/Admin
 * @security Added ownership verification
 */
router.get(
  '/income/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Income = require('../models/Income');
      const income = await Income.findOne({
        _id: req.params.id,
        organizationId: req.user.organizationId // Verify ownership
      }).populate('createdBy', 'name email');
      
      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found or access denied'
        });
      }
      
      res.status(200).json({
        success: true,
        data: income
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/expenditure/:id
 * @desc    Get single expenditure record (Admin only)
 * @access  Private/Admin
 * @security Added ownership verification
 */
router.get(
  '/expenditure/:id',
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Expenditure = require('../models/Expenditure');
      const expenditure = await Expenditure.findOne({
        _id: req.params.id,
        organizationId: req.user.organizationId // Verify ownership
      }).populate('createdBy', 'name email');
      
      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found or access denied'
        });
      }
      
      res.status(200).json({
        success: true,
        data: expenditure
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /api/transactions/income/:id
 * @desc    Update income record (Admin only)
 * @access  Private/Admin
 * @security Added audit logging and ownership verification
 */
router.put(
  '/income/:id',
  writeTransactionLimiter,
  auditTransactionAccess('UPDATE', 'INCOME'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.transaction.updateIncome,
  async (req, res, next) => {
    try {
      const Income = require('../models/Income');
      
      // Verify ownership before update
      const income = await Income.findOne({
        _id: req.params.id,
        organizationId: req.user.organizationId
      });
      
      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found or access denied'
        });
      }
      
      // Add updater information
      req.body.updatedBy = req.user.id;
      req.body.updatedAt = new Date();
      
      transactionController.updateIncome(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /api/transactions/expenditure/:id
 * @desc    Update expenditure record (Admin only)
 * @access  Private/Admin
 * @security Added audit logging and ownership verification
 */
router.put(
  '/expenditure/:id',
  writeTransactionLimiter,
  auditTransactionAccess('UPDATE', 'EXPENDITURE'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.transaction.updateExpenditure,
  async (req, res, next) => {
    try {
      const Expenditure = require('../models/Expenditure');
      
      // Verify ownership before update
      const expenditure = await Expenditure.findOne({
        _id: req.params.id,
        organizationId: req.user.organizationId
      });
      
      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found or access denied'
        });
      }
      
      // Add updater information
      req.body.updatedBy = req.user.id;
      req.body.updatedAt = new Date();
      
      transactionController.updateExpenditure(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /api/transactions/income/:id
 * @desc    Delete income record (Admin only)
 * @access  Private/Admin
 * @security Added audit logging and ownership verification
 */
router.delete(
  '/income/:id',
  writeTransactionLimiter,
  auditTransactionAccess('DELETE', 'INCOME'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Income = require('../models/Income');
      
      // Verify ownership before deletion
      const income = await Income.findOneAndDelete({
        _id: req.params.id,
        organizationId: req.user.organizationId
      });
      
      if (!income) {
        return res.status(404).json({
          success: false,
          message: 'Income record not found or access denied'
        });
      }
      
      res.status(200).json({
        success: true,
        message: 'Income record deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /api/transactions/expenditure/:id
 * @desc    Delete expenditure record (Admin only)
 * @access  Private/Admin
 * @security Added audit logging and ownership verification
 */
router.delete(
  '/expenditure/:id',
  writeTransactionLimiter,
  auditTransactionAccess('DELETE', 'EXPENDITURE'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const Expenditure = require('../models/Expenditure');
      
      // Verify ownership before deletion
      const expenditure = await Expenditure.findOneAndDelete({
        _id: req.params.id,
        organizationId: req.user.organizationId
      });
      
      if (!expenditure) {
        return res.status(404).json({
          success: false,
          message: 'Expenditure record not found or access denied'
        });
      }
      
      res.status(200).json({
        success: true,
        message: 'Expenditure record deleted successfully'
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/transactions/recent
 * @desc    Get recent transactions (Admin only)
 * @access  Private/Admin
 * @security Added limit validation and organization scoping
 */
router.get(
  '/recent',
  roleCheck('admin'),
  validateLimit,
  async (req, res, next) => {
    try {
      const { limit = 10 } = req.query;
      const safeLimit = Math.min(parseInt(limit) || 10, 100); // Max 100 items
      
      const Income = require('../models/Income');
      const Expenditure = require('../models/Expenditure');
      
      // Add organization scoping
      const organizationFilter = { organizationId: req.user.organizationId };
      
      const [incomes, expenditures] = await Promise.all([
        Income.find(organizationFilter)
          .sort({ createdAt: -1 })
          .limit(safeLimit)
          .populate('createdBy', 'name'),
        Expenditure.find(organizationFilter)
          .sort({ createdAt: -1 })
          .limit(safeLimit)
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
        data: transactions.slice(0, safeLimit)
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
 * @security Added organization scoping
 */
router.get(
  '/balance',
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const Income = require('../models/Income');
      const Expenditure = require('../models/Expenditure');
      
      // Add organization scoping
      const organizationFilter = { organizationId: req.user.organizationId };
      
      const [totalIncome, totalExpenditure] = await Promise.all([
        Income.aggregate([
          { $match: organizationFilter },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ]),
        Expenditure.aggregate([
          { $match: organizationFilter },
          { $group: { _id: null, total: { $sum: '$amount' } } }
        ])
      ]);
      
      const income = totalIncome[0]?.total || 0;
      const expenditure = totalExpenditure[0]?.total || 0;
      
      res.status(200).json({
        success: true,
        data: {
          balance: income - expenditure,
          income,
          expenditure,
          lastUpdated: new Date(),
          currency: 'NGN'
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

module.exports = router;