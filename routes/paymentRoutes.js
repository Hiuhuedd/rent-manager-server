  

// ============================================
// FILE: src/routes/paymentRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { asyncHandler } = require('../middleware/errorHandler');

const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/status', asyncHandler(paymentController.getPaymentStatus));
router.get('/volume', asyncHandler(paymentController.getPaymentVolume));
router.get('/monthly-report', asyncHandler(paymentController.getMonthlyReport));
router.get('/overdue', asyncHandler(paymentController.getOverduePayments));
router.post('/send-reminders', asyncHandler(paymentController.sendReminders));
router.post('/manual', asyncHandler(paymentController.processManualPayment));

module.exports = router;