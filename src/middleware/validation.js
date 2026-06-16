const { body, param, query, validationResult } = require('express-validator');

/**
 * Validation rules for different endpoints
 * Provides consistent validation across the application
 */
class ValidationMiddleware {
  /**
   * Check validation results
   */
  static validate(req, res, next) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Log validation failures for security monitoring
      console.warn(`Validation failed for ${req.method} ${req.url}:`, errors.array());
      
      return res.status(400).json({
        success: false,
        errors: errors.array().map(err => ({
          field: err.param,
          message: err.msg
        }))
      });
    }
    next();
  }

  /**
   * Global sanitization for all requests
   */
  static sanitizeAll(req, res, next) {
    const sanitizeString = (str) => {
      if (typeof str !== 'string') return str;
      // Trim whitespace
      let cleaned = str.trim();
      // Remove HTML tags (XSS protection)
      cleaned = cleaned.replace(/<[^>]*>/g, '');
      // Remove control characters
      cleaned = cleaned.replace(/[\x00-\x1F\x7F]/g, '');
      // Remove potential SQL/NoSQL operators
      cleaned = cleaned.replace(/[\$\{\}]/g, '');
      // Limit length to prevent DOS
      cleaned = cleaned.substring(0, 5000);
      return cleaned;
    };
    
    if (req.body) {
      Object.keys(req.body).forEach(key => {
        if (typeof req.body[key] === 'string') {
          req.body[key] = sanitizeString(req.body[key]);
        } else if (typeof req.body[key] === 'object' && req.body[key] !== null) {
          // Recursively sanitize nested objects
          const sanitizeObject = (obj) => {
            Object.keys(obj).forEach(k => {
              if (typeof obj[k] === 'string') {
                obj[k] = sanitizeString(obj[k]);
              } else if (typeof obj[k] === 'object' && obj[k] !== null) {
                sanitizeObject(obj[k]);
              }
            });
          };
          sanitizeObject(req.body[key]);
        }
      });
    }
    
    if (req.query) {
      Object.keys(req.query).forEach(key => {
        if (typeof req.query[key] === 'string') {
          req.query[key] = sanitizeString(req.query[key]);
        }
      });
    }
    
    next();
  }

  /**
   * Prevent NoSQL injection
   */
  static preventNoSQLInjection(req, res, next) {
    const hasMongoOperators = (obj) => {
      if (!obj || typeof obj !== 'object') return false;
      
      const dangerousKeys = ['$', '$gt', '$lt', '$ne', '$in', '$nin', '$or', '$and', '$not', '$exists', '$regex'];
      
      for (const key of Object.keys(obj)) {
        if (dangerousKeys.includes(key)) {
          return true;
        }
        if (typeof obj[key] === 'object') {
          if (hasMongoOperators(obj[key])) return true;
        }
      }
      return false;
    };
    
    try {
      if (hasMongoOperators(req.body) || hasMongoOperators(req.query)) {
        console.warn(`NoSQL injection attempt detected from IP: ${req.ip}`);
        return res.status(400).json({
          success: false,
          message: 'Invalid request parameters'
        });
      }
      next();
    } catch (error) {
      res.status(400).json({ success: false, message: 'Invalid request' });
    }
  }

  /**
   * Auth validation rules
   */
  static auth = {
    login: [
      body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail()
        .isLength({ max: 100 })
        .withMessage('Email too long'),
      body('password')
        .notEmpty()
        .withMessage('Password is required')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters'),
      ValidationMiddleware.validate
    ],
    
    changePassword: [
      body('currentPassword')
        .notEmpty()
        .withMessage('Current password is required'),
      body('newPassword')
        .isLength({ min: 6, max: 100 })
        .withMessage('New password must be between 6 and 100 characters')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('New password must contain at least one letter and one number')
        .custom((value, { req }) => value !== req.body.currentPassword)
        .withMessage('New password must be different from current password'),
      ValidationMiddleware.validate
    ],
    
    register: [
      body('name')
        .notEmpty()
        .withMessage('Name is required')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters')
        .matches(/^[a-zA-Z\s'-]+$/)
        .withMessage('Name can only contain letters, spaces, apostrophes, and hyphens'),
      body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail()
        .isLength({ max: 100 })
        .withMessage('Email too long'),
      body('password')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('Password must contain at least one letter and one number'),
      body('role')
        .optional()
        .isIn(['admin', 'member'])
        .withMessage('Role must be either admin or member'),
      ValidationMiddleware.validate
    ],
    
    signup: [
      body('orgName')
        .notEmpty()
        .withMessage('Organization name is required')
        .trim()
        .isLength({ min: 3, max: 100 })
        .withMessage('Organization name must be between 3 and 100 characters')
        .matches(/^[a-zA-Z0-9\s&-]+$/)
        .withMessage('Organization name contains invalid characters'),
      body('adminName')
        .notEmpty()
        .withMessage('Admin name is required')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters'),
      body('adminEmail')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
      body('adminPassword')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('Password must contain at least one letter and one number'),
      ValidationMiddleware.validate
    ],
    

    forgotPassword: [
      body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
      ValidationMiddleware.validate
    ],
    
    resetPassword: [
      param('token')
        .notEmpty()
        .withMessage('Reset token is required'),
      body('newPassword')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('Password must contain at least one letter and one number'),
      ValidationMiddleware.validate
    ],
    
    verifyAdminPin: [
      body('pin')
        .notEmpty()
        .withMessage('Admin PIN is required')
        .isLength({ min: 4, max: 6 })
        .withMessage('PIN must be 4-6 digits')
        .isNumeric()
        .withMessage('PIN must contain only numbers'),
      ValidationMiddleware.validate
    ]
  };

  /**
   * User validation rules
   */
  static user = {
    create: [
      body('name')
        .notEmpty()
        .withMessage('Name is required')
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters'),
      body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
      body('password')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters'),
      body('role')
        .optional()
        .isIn(['admin', 'member'])
        .withMessage('Role must be either admin or member'),
      ValidationMiddleware.validate
    ],
    
    update: [
      param('id')
        .isMongoId()
        .withMessage('Invalid user ID'),
      body('name')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 })
        .withMessage('Name must be between 2 and 100 characters'),
      body('email')
        .optional()
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
      body('password')
        .optional()
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters'),
      ValidationMiddleware.validate
    ],
    
    resetPassword: [
      param('id')
        .isMongoId()
        .withMessage('Invalid user ID'),
      body('newPassword')
        .isLength({ min: 6, max: 100 })
        .withMessage('Password must be between 6 and 100 characters')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('Password must contain at least one letter and one number'),
      ValidationMiddleware.validate
    ],
    
    bulkImport: [
      body('members')
        .isArray({ min: 1, max: 500 })
        .withMessage('Members must be an array with 1-500 items'),
      body('members.*.name')
        .notEmpty()
        .withMessage('Each member must have a name'),
      body('members.*.email')
        .isEmail()
        .withMessage('Each member must have a valid email'),
      ValidationMiddleware.validate
    ]
  };

  /**
   * Payment validation rules
   */
  static payment = {
    create: [
      body('userId')
        .isMongoId()
        .withMessage('Invalid user ID'),
      body('name')
        .notEmpty()
        .withMessage('Payment name is required')
        .trim()
        .isLength({ min: 3, max: 200 })
        .withMessage('Payment name must be between 3 and 200 characters'),
      body('type')
        .isIn(['registration', 'dues', 'fine', 'contribution'])
        .withMessage('Payment type must be registration, dues, fine, or contribution'),
      body('amount')
        .isFloat({ min: 0.01, max: 10000000 })
        .withMessage('Amount must be between ₦0.01 and ₦10,000,000'),
      body('dueDate')
        .optional()
        .isISO8601()
        .withMessage('Invalid due date format')
        .toDate(),
      body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description cannot exceed 500 characters'),
      ValidationMiddleware.validate
    ],
    
    initialize: [
      body('paymentId')
        .isMongoId()
        .withMessage('Invalid payment ID'),
      ValidationMiddleware.validate
    ],
    
    verify: [
      param('reference')
        .notEmpty()
        .withMessage('Transaction reference is required')
        .matches(/^[A-Z0-9_-]+$/i)
        .withMessage('Invalid reference format'),
      ValidationMiddleware.validate
    ],
    
    adminDirect: [
      body('userId')
        .isMongoId()
        .withMessage('Invalid user ID'),
      body('type')
        .isIn(['registration', 'dues', 'fine'])
        .withMessage('Invalid payment type'),
      body('amount')
        .isFloat({ min: 0.01, max: 10000000 })
        .withMessage('Amount must be between ₦0.01 and ₦10,000,000'),
      body('paidAt')
        .optional()
        .isISO8601()
        .withMessage('Invalid date format'),
      ValidationMiddleware.validate
    ]
  };

  /**
   * Transaction validation rules
   */
  static transaction = {
    income: [
      body('amount')
        .isFloat({ min: 0.01, max: 10000000 })
        .withMessage('Amount must be between ₦0.01 and ₦10,000,000'),
      body('source')
        .notEmpty()
        .withMessage('Source is required')
        .trim()
        .isLength({ min: 2, max: 200 })
        .withMessage('Source must be between 2 and 200 characters'),
      body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description cannot exceed 500 characters'),
      body('date')
        .optional()
        .isISO8601()
        .withMessage('Invalid date format')
        .toDate(),
      ValidationMiddleware.validate
    ],
    
    expenditure: [
      body('amount')
        .isFloat({ min: 0.01, max: 10000000 })
        .withMessage('Amount must be between ₦0.01 and ₦10,000,000'),
      body('purpose')
        .notEmpty()
        .withMessage('Purpose is required')
        .trim()
        .isLength({ min: 2, max: 200 })
        .withMessage('Purpose must be between 2 and 200 characters'),
      body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description cannot exceed 500 characters'),
      body('receipt')
        .optional()
        .isURL()
        .withMessage('Receipt must be a valid URL'),
      body('date')
        .optional()
        .isISO8601()
        .withMessage('Invalid date format')
        .toDate(),
      ValidationMiddleware.validate
    ],
    
    updateIncome: [
      param('id')
        .isMongoId()
        .withMessage('Invalid income ID'),
      body('amount')
        .optional()
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be greater than 0'),
      body('source')
        .optional()
        .trim()
        .isLength({ min: 2, max: 200 })
        .withMessage('Source must be between 2 and 200 characters'),
      body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description cannot exceed 500 characters'),
      ValidationMiddleware.validate
    ],
    
    updateExpenditure: [
      param('id')
        .isMongoId()
        .withMessage('Invalid expenditure ID'),
      body('amount')
        .optional()
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be greater than 0'),
      body('purpose')
        .optional()
        .trim()
        .isLength({ min: 2, max: 200 })
        .withMessage('Purpose must be between 2 and 200 characters'),
      body('description')
        .optional()
        .trim()
        .isLength({ max: 500 })
        .withMessage('Description cannot exceed 500 characters'),
      ValidationMiddleware.validate
    ]
  };

  /**
   * Report validation rules
   */
  static report = {
    summary: [
      query('startDate')
        .optional()
        .isISO8601()
        .withMessage('Invalid start date format'),
      query('endDate')
        .optional()
        .isISO8601()
        .withMessage('Invalid end date format'),
      ValidationMiddleware.validate
    ],
    financialOverview: [
      query('period')
        .optional()
        .isIn(['week', 'month', 'year'])
        .withMessage('Period must be week, month, or year')
        .trim(),
      ValidationMiddleware.validate
    ],
    export: [
      param('type')
        .isIn(['income', 'expenditure', 'payments', 'members'])
        .withMessage('Invalid report type'),
      query('startDate')
        .optional()
        .isISO8601()
        .withMessage('Invalid start date format'),
      query('endDate')
        .optional()
        .isISO8601()
        .withMessage('Invalid end date format'),
      ValidationMiddleware.validate
    ],
    
    monthly: [
      query('year')
        .optional()
        .isInt({ min: 2000, max: 2100 })
        .withMessage('Year must be between 2000 and 2100'),
      ValidationMiddleware.validate
    ]
  };

  /**
   * Organization validation rules (UPDATED for Flutterwave)
   */
  static organization = {
    create: [
      body('name')
        .notEmpty()
        .withMessage('Organization name is required')
        .trim()
        .isLength({ min: 3, max: 100 })
        .withMessage('Organization name must be between 3 and 100 characters'),
      body('slug')
        .notEmpty()
        .withMessage('Slug is required')
        .matches(/^[a-z0-9-]+$/)
        .withMessage('Slug can only contain lowercase letters, numbers, and hyphens'),
      // Flutterwave fields
      body('flutterwave.subaccountId')
        .optional()
        .matches(/^\d+$/)
        .withMessage('Invalid subaccount ID (must be numeric)'),
      body('flutterwave.subaccountCode')
        .optional()
        .matches(/^[A-Za-z0-9_-]+$/)
        .withMessage('Invalid subaccount code format'),
      body('flutterwave.bankName')
        .optional()
        .trim()
        .isLength({ min: 2, max: 100 }),
      body('flutterwave.accountNumber')
        .optional()
        .isNumeric()
        .isLength({ min: 10, max: 10 })
        .withMessage('Account number must be 10 digits'),
      // Admin creation fields
      body('adminEmail')
        .isEmail()
        .withMessage('Valid admin email is required'),
      body('adminName')
        .notEmpty()
        .withMessage('Admin name is required'),
      body('adminPassword')
        .isLength({ min: 6 })
        .withMessage('Admin password must be at least 6 characters'),
      ValidationMiddleware.validate
    ],
    
    update: [
      param('id')
        .isMongoId()
        .withMessage('Invalid organization ID'),
      body('name')
        .optional()
        .trim()
        .isLength({ min: 3, max: 100 }),
      body('slug')
        .optional()
        .matches(/^[a-z0-9-]+$/),
      // Flutterwave fields (optional update)
      body('flutterwave.subaccountId')
        .optional()
        .matches(/^\d+$/)
        .withMessage('Invalid subaccount ID'),
      body('flutterwave.subaccountCode')
        .optional()
        .matches(/^[A-Za-z0-9_-]+$/),
      body('flutterwave.bankName')
        .optional()
        .trim(),
      body('flutterwave.accountNumber')
        .optional()
        .isNumeric()
        .isLength({ min: 10, max: 10 }),
      ValidationMiddleware.validate
    ]
  };

  /**
   * Pagination validation
   */
  static pagination = [
    query('page')
      .optional()
      .isInt({ min: 1 })
      .withMessage('Page must be a positive integer')
      .toInt(),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be between 1 and 100')
      .toInt(),
    query('sort')
      .optional()
      .isIn(['asc', 'desc'])
      .withMessage('Sort must be asc or desc'),
    ValidationMiddleware.validate
  ];

  /**
   * ID parameter validation
   */
  static idParam = [
    param('id')
      .isMongoId()
      .withMessage('Invalid ID format'),
    ValidationMiddleware.validate
  ];

  /**
   * Sanitize input data (legacy - use sanitizeAll instead)
   */
  static sanitize = {
    user: [
      body('name').trim().escape(),
      body('email').normalizeEmail(),
      body('description').trim().escape()
    ],
    payment: [
      body('description').trim().escape(),
      body('source').trim().escape(),
      body('purpose').trim().escape()
    ]
  };
}

module.exports = ValidationMiddleware;