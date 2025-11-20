  
// ============================================
// FILE: src/routes/webhookRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const webhookController = require('../controllers/webhookController');
const { asyncHandler } = require('../middleware/errorHandler');

router.post('/', asyncHandler(webhookController.processMpesaWebhook));

module.exports = router;