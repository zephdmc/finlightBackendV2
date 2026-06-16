// const express = require('express');
// const router = express.Router();
// const rateLimit = require('express-rate-limit');
// const { protect } = require('../middleware/auth');
// const roleCheck = require('../middleware/roleCheck');
// const ValidationMiddleware = require('../middleware/validation');
// const organizationController = require('../controllers/organizationController');
// const { body } = require('express-validator');

// // ==================== RATE LIMITING ====================

// const adminLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 500,
//   message: { success: false, message: 'Too many requests, please try again later' }
// });

// const superAdminLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000,
//   max: 500,
//   message: { success: false, message: 'Too many requests' }
// });

// // All routes require authentication
// router.use(protect);
// router.use(adminLimiter);

// // // ==================== ADMIN ORGANIZATION SETTINGS ====================

// // // Get current user's organization settings
// // router.get(
// //   '/settings',
// //   roleCheck('admin'),
// //   organizationController.getOrganizationSettings
// // );

// // // Update current user's organization settings - REMOVED sanitizeAll and preventNoSQLInjection
// // router.put(
// //   '/settings',
// //   roleCheck('admin'),
// //   [
// //     body('paystack.subaccountCode').optional().trim().matches(/^[A-Z0-9_]+$/i).isLength({ max: 50 }),
// //     body('paystack.bankName').optional().trim().isLength({ min: 2, max: 100 }).matches(/^[a-zA-Z\s]+$/),
// //     body('paystack.accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
// //     body('paystack.percentageCharge').optional().isFloat({ min: 0, max: 100 }),
// //     body('settings.registrationFee').optional().isFloat({ min: 0, max: 1000000 }),
// //     body('settings.currency').optional().isIn(['NGN', 'USD', 'GHS', 'KES', 'ZAR']),
// //     body('settings.timezone').optional().isIn(['Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'UTC']),
// //   ],
// //   ValidationMiddleware.validate,
// //   organizationController.updateOrganizationSettings
// // );
// // Update organization settings (now using Flutterwave)
// router.put(
//   '/settings',
//   roleCheck('admin'),
//   [
//     // Flutterwave subaccount fields
//     body('flutterwave.subaccountId').optional().trim().matches(/^\d+$/).isLength({ min: 1, max: 20 }),
//     body('flutterwave.subaccountCode').optional().trim().isLength({ max: 50 }),
//     body('flutterwave.bankName').optional().trim().isLength({ min: 2, max: 100 }),
//     body('flutterwave.accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
//     // Optional: keep paystack fields for historical data (not used)
//     body('paystack.subaccountCode').optional().trim(),
//     body('paystack.bankName').optional().trim(),
//     body('paystack.accountNumber').optional().trim(),
//     body('paystack.percentageCharge').optional().isFloat({ min: 0, max: 100 }),
//     // General settings
//     body('settings.registrationFee').optional().isFloat({ min: 0, max: 1000000 }),
//     body('settings.currency').optional().isIn(['NGN', 'USD', 'GHS', 'KES', 'ZAR']),
//     body('settings.timezone').optional().isIn(['Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'UTC']),
//   ],
//   ValidationMiddleware.validate,
//   organizationController.updateOrganizationSettings
// );

// // Update bank details (Flutterwave subaccount)
// router.put(
//   '/bank-details',
//   roleCheck('admin'),
//   [
//     body('subaccountId').optional().trim().matches(/^\d+$/),
//     body('subaccountCode').optional().trim(),
//     body('bankName').optional().trim().isLength({ min: 2, max: 100 }),
//     body('accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
//     body('accountName').optional().trim().isLength({ min: 2, max: 100 }),
//   ],
//   ValidationMiddleware.validate,
//   organizationController.updateBankDetails
// );
// // Update bank details
// router.put(
//   '/bank-details',
//   roleCheck('admin'),
//   [
//     body('bankName').optional().trim().isLength({ min: 2, max: 100 }),
//     body('accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
//     body('accountName').optional().trim().isLength({ min: 2, max: 100 }),
//     body('subaccountCode').optional().trim().matches(/^[A-Z0-9_]+$/i),
//   ],
//   ValidationMiddleware.validate,
//   organizationController.updateBankDetails
// );

// // ==================== SUPER ADMIN ENDPOINTS ====================

// // Get all organizations (Super Admin only)
// router.get(
//   '/',
//   roleCheck('super-admin', 'super_admin'),
//   superAdminLimiter,
//   ValidationMiddleware.pagination,
//   organizationController.getAllOrganizations
// );

// // Get single organization by ID
// router.get(
//   '/:id',
//   roleCheck('super-admin', 'super_admin'),
//   ValidationMiddleware.idParam,
//   organizationController.getOrganizationById
// );

// // Update organization status
// router.patch(
//   '/:id/status',
//   roleCheck('super-admin', 'super_admin'),
//   ValidationMiddleware.idParam,
//   [
//     body('status').notEmpty().isIn(['active', 'inactive', 'suspended']),
//     body('reason').optional().trim().isLength({ max: 500 })
//   ],
//   ValidationMiddleware.validate,
//   organizationController.updateOrganizationStatus
// );

// // Get organization statistics summary
// router.get(
//   '/stats/summary',
//   roleCheck('super-admin', 'super_admin'),
//   organizationController.getOrganizationStats
// );

// // Create new organization
// router.post(
//   '/',
//   roleCheck('super-admin', 'super_admin'),
//   superAdminLimiter,
//   ValidationMiddleware.organization.create,
//   organizationController.createOrganization
// );

// // Update organization
// router.put(
//   '/:id',
//   roleCheck('super-admin', 'super_admin'),
//   ValidationMiddleware.idParam,
//   ValidationMiddleware.organization.update,
//   organizationController.updateOrganization
// );

// // Delete organization
// router.delete(
//   '/:id',
//   roleCheck('super-admin', 'super_admin'),
//   ValidationMiddleware.idParam,
//   organizationController.deleteOrganization
// );

// // Add this to your organizationroute.js (if missing)
// router.get('/subaccount/status',
//   roleCheck('admin'),
//   organizationController.getSubaccountStatus
// );

// module.exports = router;


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

// Update current user's organization settings (Flutterwave)
router.put(
  '/settings',
  roleCheck('admin'),
  [
    // Flutterwave subaccount fields
    body('flutterwave.subaccountId').optional().trim().matches(/^\d+$/).isLength({ min: 1, max: 20 }),
    body('flutterwave.subaccountCode').optional().trim().isLength({ max: 50 }),
    body('flutterwave.bankName').optional().trim().isLength({ min: 2, max: 100 }),
    body('flutterwave.accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
    // General settings
    body('settings.registrationFee').optional().isFloat({ min: 0, max: 1000000 }),
    body('settings.currency').optional().isIn(['NGN', 'USD', 'GHS', 'KES', 'ZAR']),
    body('settings.timezone').optional().isIn(['Africa/Lagos', 'Africa/Nairobi', 'Africa/Johannesburg', 'Africa/Cairo', 'UTC']),
  ],
  ValidationMiddleware.validate,
  organizationController.updateOrganizationSettings
);

// Update bank details and create Flutterwave subaccount
router.put(
  '/bank-details',
  roleCheck('admin'),
  [
    body('bankName').optional().trim().isLength({ min: 2, max: 100 }),
    body('accountNumber').optional().trim().isNumeric().isLength({ min: 10, max: 10 }),
    body('accountName').optional().trim().isLength({ min: 2, max: 100 }),
    // Flutterwave subaccount fields (returned after creation)
    body('subaccountId').optional().trim().matches(/^\d+$/),
    body('subaccountCode').optional().trim(),
  ],
  ValidationMiddleware.validate,
  organizationController.updateBankDetails
);

// Get Flutterwave subaccount status
router.get('/subaccount/status', 
  roleCheck('admin'), 
  organizationController.getSubaccountStatus
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