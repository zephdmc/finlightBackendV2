// const express = require('express');
// const router = express.Router();
// const { protect } = require('../middleware/auth');
// const orgController = require('../controllers/organizationController');
// const ValidationMiddleware = require('../middleware/validation');

// router.use(protect);

// // Super admin check
// router.use((req, res, next) => {
//   if (req.user.role !== 'super-admin' && req.user.role !== 'super_admin') {
//     return res.status(403).json({ success: false, message: 'Super admin access required' });
//   }
//   next();
// });

// // Apply validation to POST and PUT
// router.get('/organizations', orgController.getAllOrganizations);
// router.post('/organizations',
//   ValidationMiddleware.sanitizeAll,
//   ValidationMiddleware.organization.create,
//   orgController.createOrganization
// );
// router.put('/organizations/:id',
//   ValidationMiddleware.idParam,
//   ValidationMiddleware.sanitizeAll,
//   ValidationMiddleware.organization.update,
//   orgController.updateOrganization
// );
// router.delete('/organizations/:id',
//   ValidationMiddleware.idParam,
//   orgController.deleteOrganization
// );
// router.get('/organizations/:id',
//   ValidationMiddleware.idParam,
//   orgController.getOrganizationById
// );

// module.exports = router;

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { protect } = require('../middleware/auth');
const orgController = require('../controllers/organizationController');
const ValidationMiddleware = require('../middleware/validation');

// ==================== RATE LIMITING ====================

const superAdminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { success: false, message: 'Too many requests. Please try again later.' }
});

// ==================== MIDDLEWARE ====================

router.use(protect);
router.use(superAdminLimiter);

// Super admin check
router.use((req, res, next) => {
  const isSuperAdmin = req.user.role === 'super-admin' || req.user.role === 'super_admin';
  if (!isSuperAdmin) {
    return res.status(403).json({ 
      success: false, 
      message: 'Super admin access required' 
    });
  }
  next();
});

// ==================== ROUTES ====================

// Get all organizations
router.get('/organizations', orgController.getAllOrganizations);

// Create organization - REMOVED sanitizeAll
router.post(
  '/organizations', 
  ValidationMiddleware.organization.create, // REMOVED: sanitizeAll
  orgController.createOrganization
);

// Update organization - REMOVED sanitizeAll
router.put(
  '/organizations/:id',
  ValidationMiddleware.idParam,
  ValidationMiddleware.organization.update, // REMOVED: sanitizeAll
  orgController.updateOrganization
);

// Delete organization
router.delete(
  '/organizations/:id',
  ValidationMiddleware.idParam,
  orgController.deleteOrganization
);

// Get organization by ID
router.get(
  '/organizations/:id',
  ValidationMiddleware.idParam,
  orgController.getOrganizationById
);

module.exports = router;