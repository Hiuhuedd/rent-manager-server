  
// ============================================
// FILE: src/routes/webhookRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const { asyncHandler } = require('../middleware/errorHandler');

router.post('/', asyncHandler(webhookController.processMpesaWebhook));
router.post('/gateway/validation', asyncHandler(webhookController.processDarajaValidation));
router.post('/gateway/confirmation', asyncHandler(webhookController.processDarajaConfirmation));

module.exports = router;