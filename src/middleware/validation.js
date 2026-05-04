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
   * Auth validation rules
   */
  static auth = {
    login: [
      body('email')
        .isEmail()
        .withMessage('Please provide a valid email address')
        .normalizeEmail(),
      body('password')
        .notEmpty()
        .withMessage('Password is required')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long'),
      ValidationMiddleware.validate
      ],
      changePassword: [
        body('currentPassword')
          .notEmpty()
          .withMessage('Current password is required'),
        body('newPassword')
          .isLength({ min: 6 })
          .withMessage('New password must be at least 6 characters long')
          .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
          .withMessage('New password must contain at least one letter and one number'),
        ValidationMiddleware.validate
      ],
    register: [
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
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('Password must contain at least one letter and one number'),
      body('role')
        .optional()
        .isIn(['admin', 'member'])
        .withMessage('Role must be either admin or member'),
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
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long'),
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
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long'),
      ValidationMiddleware.validate
    ],
    resetPassword: [
      param('id')
        .isMongoId()
        .withMessage('Invalid user ID'),
      body('newPassword')
        .isLength({ min: 6 })
        .withMessage('Password must be at least 6 characters long')
        .matches(/^(?=.*[A-Za-z])(?=.*\d)/)
        .withMessage('Password must contain at least one letter and one number'),
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
      body('type')
        .isIn(['registration', 'dues', 'fine'])
        .withMessage('Payment type must be registration, dues, or fine'),
      body('amount')
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be greater than 0'),
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
        .matches(/^[A-Z0-9_]+$/)
        .withMessage('Invalid reference format'),
      ValidationMiddleware.validate
    ]
  };

  /**
   * Transaction validation rules
   */
  static transaction = {
    income: [
      body('amount')
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be greater than 0'),
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
      ValidationMiddleware.validate
    ],
    expenditure: [
      body('amount')
        .isFloat({ min: 0.01 })
        .withMessage('Amount must be greater than 0'),
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
   * Sanitize input data
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