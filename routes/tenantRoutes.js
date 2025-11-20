  


// ============================================
// FILE: src/routes/tenantRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');
const { validateTenantInput } = require('../middleware/validator');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', asyncHandler(tenantController.getAllTenants));
router.get('/:id', asyncHandler(tenantController.getTenantById));
router.get('/:id/payment-status', asyncHandler(tenantController.getPaymentStatus));
router.post('/', validateTenantInput, asyncHandler(tenantController.createTenant));
router.delete('/:tenantId', asyncHandler(tenantController.deleteTenant));
router.post('/:id/send-reminder', asyncHandler(tenantController.sendReminder));
router.post('/:id/send-confirmation', asyncHandler(tenantController.sendConfirmation));

module.exports = router;