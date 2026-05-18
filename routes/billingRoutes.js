const express = require('express');
const router = express.Router();
const billingController = require('../controllers/billingController');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// Public webhook endpoint called directly by Safaricom Daraja API
router.post('/mpesa-callback', asyncHandler(billingController.processMpesaCallback));

// Apply auth middleware for all agent-initiated checkout requests
router.use(authMiddleware);

router.get('/sms-usage', asyncHandler(billingController.getSmsUsage));
router.post('/purchase-plan', asyncHandler(billingController.purchasePlan));
router.post('/mpesa-stk', asyncHandler(billingController.initiateMpesaStk));

module.exports = router;
