const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const roleCheck = require('../middleware/roleCheck');
const ValidationMiddleware = require('../middleware/validation');
const organizationController = require('../controllers/organizationController');
const { body } = require('express-validator');

// ==================== RATE LIMITING ====================

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { success: false, message: 'Too many requests, please try again later' }
});

const superAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  message: { success: false, message: 'Too many requests' }
});

// All routes require authentication
router.use(protect);
router.use(adminLimiter);

// ==================== ADMIN ORGANIZATION SETTINGS ====================

// Get current user's organization settings
router.get(
  '/settings',
  roleCheck('admin'),
  organizationController.getOrganizationSettings
);

// Update current user's organization settings - REMOVED sanitizeAll and preventNoSQLInjection
router.put(
  '/settings',
  roleCheck('admin'),
  [
    body('paystack.subaccountCode').optional().trim().matches(/^[A-Z0-9_]+$/i).isLength({ max: 50 }),
    body('paystack.bankName').optional().trim().isLength({ min: 2, max: 100 }).matches(/^[a-zA-Z\s]+$/),
    body('paystack.accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
    body('paystack.percentageCharge').optional().isFloat({ min: 0, max: 100 }),
    body('settings.registrationFee').optional().isFloat({ min: 0, max: 1000000 }),
    body('settings.currency').optional().isIn(['NGN', 'USD', 'GHS', 'KES', 'ZAR']),
    body('settings.timezone').optional().isIn(['Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'UTC']),
  ],
  ValidationMiddleware.validate,
  organizationController.updateOrganizationSettings
);

// Update bank details
router.put(
  '/bank-details',
  roleCheck('admin'),
  [
    body('bankName').optional().trim().isLength({ min: 2, max: 100 }),
    body('accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
    body('accountName').optional().trim().isLength({ min: 2, max: 100 }),
    body('subaccountCode').optional().trim().matches(/^[A-Z0-9_]+$/i),
  ],
  ValidationMiddleware.validate,
  organizationController.updateBankDetails
);

// ==================== SUPER ADMIN ENDPOINTS ====================

// Get all organizations (Super Admin only)
router.get(
  '/',
  roleCheck('super-admin', 'super_admin'),
  superAdminLimiter,
  ValidationMiddleware.pagination,
  organizationController.getAllOrganizations
);

// Get single organization by ID
router.get(
  '/:id',
  roleCheck('super-admin', 'super_admin'),
  ValidationMiddleware.idParam,
  organizationController.getOrganizationById
);

// Update organization status
router.patch(
  '/:id/status',
  roleCheck('super-admin', 'super_admin'),
  ValidationMiddleware.idParam,
  [
    body('status').notEmpty().isIn(['active', 'inactive', 'suspended']),
    body('reason').optional().trim().isLength({ max: 500 })
  ],
  ValidationMiddleware.validate,
  organizationController.updateOrganizationStatus
);

// Get organization statistics summary
router.get(
  '/stats/summary',
  roleCheck('super-admin', 'super_admin'),
  organizationController.getOrganizationStats
);

// Create new organization
router.post(
  '/',
  roleCheck('super-admin', 'super_admin'),
  superAdminLimiter,
  ValidationMiddleware.organization.create,
  organizationController.createOrganization
);

// Update organization
router.put(
  '/:id',
  roleCheck('super-admin', 'super_admin'),
  ValidationMiddleware.idParam,
  ValidationMiddleware.organization.update,
  organizationController.updateOrganization
);

// Delete organization
router.delete(
  '/:id',
  roleCheck('super-admin', 'super_admin'),
  ValidationMiddleware.idParam,
  organizationController.deleteOrganization
);

module.exports = router;