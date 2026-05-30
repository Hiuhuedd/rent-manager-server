  


// ============================================
// FILE: src/routes/tenantRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const tenantController = require('../controllers/tenantController');
const { validateTenantInput } = require('../middleware/validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/', asyncHandler(tenantController.getAllTenants));
router.get('/:id', asyncHandler(tenantController.getTenantById));
router.get('/:id/payment-status', asyncHandler(tenantController.getPaymentStatus));
router.post('/', validateTenantInput, asyncHandler(tenantController.createTenant));
router.put('/:tenantId', asyncHandler(tenantController.updateTenant));
router.delete('/:tenantId', asyncHandler(tenantController.deleteTenant));
router.post('/:id/send-reminder', asyncHandler(tenantController.sendReminder));
router.post('/:id/send-confirmation', asyncHandler(tenantController.sendConfirmation));
router.post('/:id/apply-penalty', asyncHandler(tenantController.applyPenalty));
router.post('/:id/remove-penalty', asyncHandler(tenantController.removePenalty));

module.exports = router;