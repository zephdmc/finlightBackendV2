const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const orgController = require('../controllers/organizationController');

// All routes require authentication and super_admin role (checked inside controller)
router.use(protect);
router.use((req, res, next) => orgController.requireSuperAdmin(req, res, next));

router.get('/organizations', (req, res, next) => orgController.getAllOrganizations(req, res, next));
router.post('/organizations', (req, res, next) => orgController.createOrganization(req, res, next));
router.put('/organizations/:id', (req, res, next) => orgController.updateOrganization(req, res, next));
router.delete('/organizations/:id', (req, res, next) => orgController.deleteOrganization(req, res, next));

module.exports = router;