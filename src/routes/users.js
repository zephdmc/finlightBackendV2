const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const rateLimit = require('express-rate-limit');
const { body, param, query } = require('express-validator');

// ==================== SECURITY MIDDLEWARE ====================

// User route rate limiting
const userRouteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // 100 requests per 15 minutes
  message: {
    success: false,
    message: 'Too many requests to user endpoints. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limiter for sensitive operations
const sensitiveOperationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 40, // 10 sensitive operations per hour
  message: {
    success: false,
    message: 'Rate limit exceeded for sensitive operations.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Export rate limiter (even stricter due to data volume)
const exportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 23, // Only 5 exports per hour
  message: {
    success: false,
    message: 'Export limit exceeded. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Audit logging middleware for user operations
const auditUserAccess = (action) => {
  return async (req, res, next) => {
    const originalEnd = res.end;
    const startTime = Date.now();
    const targetUserId = req.params.id || req.body.userId;
    
    res.end = function(chunk, encoding) {
      const responseTime = Date.now() - startTime;
      
      // Only log if operation was performed on a user
      if (targetUserId || action === 'LIST_ALL' || action === 'EXPORT') {
        setImmediate(() => {
          try {
            const AuditLog = require('../models/AuditLog');
            AuditLog.create({
              userId: req.user.id,
              userEmail: req.user.email,
              userRole: req.user.role,
              action: `USER_${action}`,
              resourceType: 'USER',
              resourceId: targetUserId,
              details: {
                method: req.method,
                url: req.originalUrl,
                targetUserId: targetUserId,
                body: action === 'CREATE' || action === 'UPDATE' ? 
                  { ...req.body, password: undefined, currentPassword: undefined } : 
                  undefined
              },
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
      }
      
      originalEnd.call(this, chunk, encoding);
    };
    
    next();
  };
};

// Authorization middleware for user access
const checkUserAccess = async (req, res, next) => {
  try {
    const targetUserId = req.params.id;
    
    // If no specific user target, allow (for listing endpoints)
    if (!targetUserId) {
      // Admin-only endpoints are already protected by roleCheck
      return next();
    }
    
    // Admin can access any user
    if (req.user.role === 'admin') {
      return next();
    }
    
    // Users can only access their own data
    if (req.user.id === targetUserId) {
      return next();
    }
    
    // Check if user is trying to access a member's data (team leads might have access)
    // This is optional - implement if you have team lead roles
    if (req.user.role === 'team_lead') {
      const User = require('../models/User');
      const targetUser = await User.findById(targetUserId);
      if (targetUser && targetUser.organizationId === req.user.organizationId) {
        // Team leads can view members in their organization
        if (req.method === 'GET') {
          return next();
        }
      }
    }
    
    return res.status(403).json({
      success: false,
      message: 'Access denied. You can only access your own user data.'
    });
  } catch (error) {
    console.error('User access check error:', error);
    next(error);
  }
};

// Validate user exists middleware
const validateUserExists = async (req, res, next) => {
  try {
    const User = require('../models/User');
    const user = await User.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }
    
    // Attach user to request for later use
    req.targetUser = user;
    next();
  } catch (error) {
    next(error);
  }
};

// Validate bulk import data
const validateBulkImport = [
  body('members')
    .isArray({ min: 1, max: 500 })
    .withMessage('Members must be an array with 1-500 items'),
  body('members.*.name')
    .notEmpty()
    .withMessage('Each member must have a name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Name must be between 2 and 100 characters'),
  body('members.*.email')
    .isEmail()
    .withMessage('Each member must have a valid email')
    .normalizeEmail(),
  body('members.*.password')
    .optional()
    .isLength({ min: 6, max: 100 })
    .withMessage('Password must be between 6 and 100 characters'),
  ValidationMiddleware.validate
];

// All routes require authentication
router.use(protect);
router.use(userRouteLimiter);
router.use(auditUserAccess('ACCESS')); // Log all user route access

// ==================== ROUTES ====================

/**
 * @route   GET /api/users
 * @desc    Get all users
 * @access  Private (Members see limited, Admins see all)
 * @security Added organization scoping and role-based filtering
 */
router.get(
  '/',
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { page = 1, limit = 20, search, role } = req.query;
      const User = require('../models/User');
      
      // Build filter with organization scoping
      const filter = { organizationId: req.user.organizationId };
      
      // Role-based filtering
      if (req.user.role !== 'admin') {
        // Non-admins can only see members (not other admins)
        filter.role = 'member';
      } else if (role && ['admin', 'member', 'team_lead'].includes(role)) {
        // Admins can filter by role
        filter.role = role;
      }
      
      // Add search functionality
      if (search) {
        filter.$or = [
          { name: { $regex: search, $options: 'i' } },
          { email: { $regex: search, $options: 'i' } }
        ];
      }
      
      const skip = (parseInt(page) - 1) * parseInt(limit);
      
      // Select fields based on role
      const selectFields = req.user.role === 'admin' 
        ? '-password -resetPasswordToken -resetPasswordExpire'
        : 'name email role createdAt hasPaidRegistration';
      
      const [users, total] = await Promise.all([
        User.find(filter)
          .select(selectFields)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(parseInt(limit)),
        User.countDocuments(filter)
      ]);
      
      res.status(200).json({
        success: true,
        data: users,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit))
        },
        role: req.user.role // Inform client of their access level
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/users/stats
 * @desc    Get user statistics (Admin only)
 * @access  Private/Admin
 * @security Added organization scoping
 */
router.get(
  '/stats',
  sensitiveOperationLimiter,
  auditUserAccess('VIEW_STATS'),
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      const Payment = require('../models/Payment');
      
      // Add organization scoping
      const organizationFilter = { organizationId: req.user.organizationId };
      
      const [totalUsers, adminCount, memberCount, registrationStats] = await Promise.all([
        User.countDocuments(organizationFilter),
        User.countDocuments({ ...organizationFilter, role: 'admin' }),
        User.countDocuments({ ...organizationFilter, role: 'member' }),
        Payment.aggregate([
          { 
            $match: { 
              type: 'registration',
              ...organizationFilter 
            } 
          },
          { 
            $group: { 
              _id: '$status', 
              count: { $sum: 1 } 
            } 
          }
        ])
      ]);
      
      const paidRegistration = registrationStats.find(s => s._id === 'paid')?.count || 0;
      const unpaidRegistration = registrationStats.find(s => s._id === 'unpaid')?.count || 0;
      
      res.status(200).json({
        success: true,
        data: {
          totalUsers,
          adminCount,
          memberCount,
          registrationProgress: {
            paid: paidRegistration,
            unpaid: unpaidRegistration,
            pending: totalUsers - (paidRegistration + unpaidRegistration)
          },
          organizationId: req.user.organizationId
        }
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/users/register
 * @desc    Register new member (Admin only)
 * @access  Private/Admin
 * @security Added organization assignment and audit logging
 */
router.post(
  '/register',
  sensitiveOperationLimiter,
  auditUserAccess('CREATE'),
  roleCheck('admin'),
  ValidationMiddleware.user.create,
  async (req, res, next) => {
    try {
      // Ensure new user belongs to the admin's organization
      req.body.organizationId = req.user.organizationId;
      req.body.createdBy = req.user.id;
      
      // Forward to controller
      userController.registerMember(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/users/bulk-import
 * @desc    Bulk import members (Admin only)
 * @access  Private/Admin
 * @security Added validation, organization assignment, and audit logging
 */
router.post(
  '/bulk-import',
  sensitiveOperationLimiter,
  auditUserAccess('BULK_IMPORT'),
  roleCheck('admin'),
  validateBulkImport,
  async (req, res, next) => {
    try {
      // Add organization ID to all members
      req.body.members = req.body.members.map(member => ({
        ...member,
        organizationId: req.user.organizationId,
        createdBy: req.user.id,
        role: 'member' // Force role to member for security
      }));
      
      userController.bulkImportMembers(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/users/:id
 * @desc    Get user by ID
 * @access  Private (Admin or self)
 * @security Added access control and field filtering
 */
router.get(
  '/:id',
  ValidationMiddleware.idParam,
  checkUserAccess,
  validateUserExists,
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      
      // Select fields based on requester role
      const selectFields = req.user.role === 'admin' || req.user.id === req.params.id
        ? '-password -resetPasswordToken -resetPasswordExpire'
        : 'name email role createdAt hasPaidRegistration';
      
      const user = await User.findById(req.params.id).select(selectFields);
      
      res.status(200).json({
        success: true,
        data: user
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   PUT /api/users/:id
 * @desc    Update user
 * @access  Private (Admin or self)
 * @security Added access control and field update restrictions
 */
router.put(
  '/:id',
  sensitiveOperationLimiter,
  auditUserAccess('UPDATE'),
  ValidationMiddleware.idParam,
  checkUserAccess,
  validateUserExists,
  ValidationMiddleware.user.update,
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      
      // Prevent non-admins from changing role
      if (req.user.role !== 'admin' && req.body.role) {
        delete req.body.role;
      }
      
      // Prevent changing organization ID
      if (req.body.organizationId) {
        delete req.body.organizationId;
      }
      
      // Add updater information
      req.body.updatedBy = req.user.id;
      req.body.updatedAt = new Date();
      
      userController.updateUser(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   DELETE /api/users/:id
 * @desc    Delete user (Admin only)
 * @access  Private/Admin
 * @security Added organization scoping and prevention of self-deletion
 */
router.delete(
  '/:id',
  sensitiveOperationLimiter,
  auditUserAccess('DELETE'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  validateUserExists,
  async (req, res, next) => {
    try {
      // Prevent admin from deleting themselves
      if (req.params.id === req.user.id) {
        return res.status(400).json({
          success: false,
          message: 'Cannot delete your own account. Ask another admin to do this.'
        });
      }
      
      // Ensure user belongs to same organization
      if (req.targetUser.organizationId.toString() !== req.user.organizationId) {
        return res.status(403).json({
          success: false,
          message: 'Cannot delete users from other organizations'
        });
      }
      
      userController.deleteUser(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/users/:id/reset-password
 * @desc    Reset user password (Admin only)
 * @access  Private/Admin
 * @security Added organization scoping and audit logging
 */
router.post(
  '/:id/reset-password',
  sensitiveOperationLimiter,
  auditUserAccess('RESET_PASSWORD'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  validateUserExists,
  ValidationMiddleware.user.resetPassword,
  async (req, res, next) => {
    try {
      // Ensure user belongs to same organization
      if (req.targetUser.organizationId.toString() !== req.user.organizationId) {
        return res.status(403).json({
          success: false,
          message: 'Cannot reset password for users from other organizations'
        });
      }
      
      userController.resetPassword(req, res, next);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/users/:id/payment-summary
 * @desc    Get member payment summary
 * @access  Private (Admin or self)
 * @security Added access control and organization scoping
 */
// router.get(
//   '/:id/payment-summary',
//   ValidationMiddleware.idParam,
//   // checkUserAccess,
//   validateUserExists,
//   async (req, res, next) => {
//     try {
//       // Add organization check
//       if (req.targetUser.organizationId.toString() !== req.user.organizationId) {
//         return res.status(403).json({
//           success: false,
//           message: 'Access denied'
//         });
//       }
      
//       userController.getMemberPaymentSummary(req, res, next);
//     } catch (error) {
//       next(error);
//     }
//   }
// );


/**
 * @route   GET /api/users/:id/payment-summary
 * @desc    Get member payment summary
 * @access  Private (Admin or self)
 */
/**
 * @route   GET /api/users/:id/payment-summary
 * @desc    Get member payment summary
 * @access  Private (Admin or self)
 */
router.get(
  '/:id/payment-summary',
  ValidationMiddleware.idParam,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      
      // Convert both to strings for proper comparison
      const requestingUserId = req.user.id.toString();
      const targetUserId = id.toString();
      
      // Authorization: admin OR requesting own data
      if (req.user.role !== 'admin' && requestingUserId !== targetUserId) {
        console.log(`Authorization failed: User ${requestingUserId} (role: ${req.user.role}) tried to access ${targetUserId}`);
        return res.status(403).json({
          success: false,
          message: 'Not authorized to view this payment summary'
        });
      }
      
      // Add organization check
      const User = require('../models/User');
      const targetUser = await User.findById(id);
      
      if (!targetUser) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
      
      // For non-admin users, ensure they belong to the same organization
      if (req.user.role !== 'admin' && targetUser.organizationId.toString() !== req.user.organizationId.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Access denied'
        });
      }
      
      // Call the controller
      userController.getMemberPaymentSummary(req, res, next);
    } catch (error) {
      console.error('Payment summary error:', error);
      next(error);
    }
  }
);
/**
 * @route   GET /api/users/:id/transactions
 * @desc    Get user's transaction history
 * @access  Private (Admin or self)
 * @security Fixed IDOR vulnerability, added organization scoping
 */
router.get(
  '/:id/transactions',
  ValidationMiddleware.idParam,
  checkUserAccess, // FIXED: Added proper authorization
  validateUserExists,
  ValidationMiddleware.pagination,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const { page = 1, limit = 20, startDate, endDate } = req.query;
      const Payment = require('../models/Payment');
      
      // Build filter with organization scoping
      const filter = { 
        user: id,
        organizationId: req.user.organizationId // Ensure same organization
      };
      
      // Add date range filter
      if (startDate || endDate) {
        filter.createdAt = {};
        if (startDate) filter.createdAt.$gte = new Date(startDate);
        if (endDate) filter.createdAt.$lte = new Date(endDate);
      }
      
      // Validate and sanitize pagination parameters
      const safeLimit = Math.min(parseInt(limit) || 20, 100);
      const safePage = Math.max(parseInt(page) || 1, 1);
      const skip = (safePage - 1) * safeLimit;
      
      const [payments, total] = await Promise.all([
        Payment.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(safeLimit)
          .select('-__v'), // Exclude version field
        Payment.countDocuments(filter)
      ]);
      
      // Calculate summary from ALL payments (not just current page)
      const [allPayments] = await Promise.all([
        Payment.find(filter).select('amount status')
      ]);
      
      const summary = {
        totalPaid: allPayments
          .filter(p => p.status === 'paid')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        totalOutstanding: allPayments
          .filter(p => p.status === 'unpaid')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        totalRefunded: allPayments
          .filter(p => p.status === 'refunded')
          .reduce((sum, p) => sum + (p.amount || 0), 0),
        paidCount: allPayments.filter(p => p.status === 'paid').length,
        unpaidCount: allPayments.filter(p => p.status === 'unpaid').length,
        refundedCount: allPayments.filter(p => p.status === 'refunded').length
      };
      
      res.status(200).json({
        success: true,
        data: {
          payments,
          summary,
          pagination: {
            page: safePage,
            limit: safeLimit,
            total,
            pages: Math.ceil(total / safeLimit)
          }
        }
      });
    } catch (error) {
      console.error('Transaction history error:', error);
      next(error);
    }
  }
);

/**
 * @route   POST /api/users/:id/verify-registration
 * @desc    Manually verify registration payment (Admin only)
 * @access  Private/Admin
 * @security Added organization scoping and validation
 */
router.post(
  '/:id/verify-registration',
  sensitiveOperationLimiter,
  auditUserAccess('VERIFY_REGISTRATION'),
  roleCheck('admin'),
  ValidationMiddleware.idParam,
  validateUserExists,
  async (req, res, next) => {
    try {
      const { id } = req.params;
      const User = require('../models/User');
      const Payment = require('../models/Payment');
      
      // Ensure user belongs to same organization
      if (req.targetUser.organizationId.toString() !== req.user.organizationId) {
        return res.status(403).json({
          success: false,
          message: 'Cannot verify users from other organizations'
        });
      }
      
      const user = req.targetUser;
      
      // Check if user already has paid registration
      if (user.hasPaidRegistration) {
        return res.status(400).json({
          success: false,
          message: 'Registration already verified'
        });
      }
      
      const registrationPayment = await Payment.findOne({
        user: id,
        type: 'registration',
        organizationId: req.user.organizationId
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
          message: 'Registration payment already marked as paid'
        });
      }
      
      // Manually verify registration with audit trail
      registrationPayment.status = 'paid';
      registrationPayment.paidAt = new Date();
      registrationPayment.verifiedBy = req.user.id;
      registrationPayment.verificationMethod = 'manual_admin';
      await registrationPayment.save();
      
      user.hasPaidRegistration = true;
      user.registrationVerifiedAt = new Date();
      user.registrationVerifiedBy = req.user.id;
      await user.save();
      
      // Log the manual verification
      console.log(`Admin ${req.user.email} manually verified registration for user ${user.email}`);
      
      res.status(200).json({
        success: true,
        message: 'Registration verified successfully',
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            hasPaidRegistration: user.hasPaidRegistration,
            verifiedAt: user.registrationVerifiedAt
          },
          payment: {
            id: registrationPayment._id,
            status: registrationPayment.status,
            paidAt: registrationPayment.paidAt,
            verifiedBy: req.user.email
          }
        }
      });
    } catch (error) {
      console.error('Registration verification error:', error);
      next(error);
    }
  }
);

/**
 * @route   GET /api/users/export/all
 * @desc    Export all members (Admin only)
 * @access  Private/Admin
 * @security Added rate limiting, organization scoping, and data sanitization
 */
router.get(
  '/export/all',
  exportLimiter, // Stricter rate limit for exports
  auditUserAccess('EXPORT'),
  roleCheck('admin'),
  async (req, res, next) => {
    try {
      const User = require('../models/User');
      const Payment = require('../models/Payment');
      
      // Add organization scoping
      const organizationFilter = { 
        role: 'member',
        organizationId: req.user.organizationId 
      };
      
      // Add optional date filter
      const { fromDate, toDate } = req.query;
      if (fromDate || toDate) {
        organizationFilter.createdAt = {};
        if (fromDate) organizationFilter.createdAt.$gte = new Date(fromDate);
        if (toDate) organizationFilter.createdAt.$lte = new Date(toDate);
      }
      
      const users = await User.find(organizationFilter)
        .select('name email createdAt hasPaidRegistration')
        .sort({ createdAt: -1 })
        .limit(10000); // Limit export size for performance
      
      if (users.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'No members found to export'
        });
      }
      
      // Get payment information with organization scoping
      const usersWithPayment = await Promise.all(
        users.map(async (user) => {
          const registration = await Payment.findOne({
            user: user._id,
            type: 'registration',
            organizationId: req.user.organizationId
          }).select('status amount paidAt');
          
          // Get total payments
          const allPayments = await Payment.find({
            user: user._id,
            organizationId: req.user.organizationId,
            status: 'paid'
          }).select('amount');
          
          const totalPaid = allPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
          
          return {
            name: user.name,
            email: user.email,
            registeredAt: user.createdAt,
            registrationStatus: registration?.status || 'pending',
            registrationAmount: registration?.amount || 0,
            registrationPaidAt: registration?.paidAt || null,
            hasPaidRegistration: user.hasPaidRegistration,
            totalPayments: totalPaid,
            lastUpdated: new Date()
          };
        })
      );
      
      // Consider using CSV library for large exports
      // For now, return JSON with export metadata
      res.status(200).json({
        success: true,
        data: usersWithPayment,
        metadata: {
          exportDate: new Date(),
          exportedBy: req.user.email,
          totalRecords: usersWithPayment.length,
          organizationId: req.user.organizationId,
          filename: `members_export_${Date.now()}.json`,
          message: 'Consider implementing CSV export for better performance'
        }
      });
    } catch (error) {
      console.error('Export error:', error);
      next(error);
    }
  }
);

module.exports = router;