  

// ============================================
// FILE: src/routes/paymentRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/status', asyncHandler(paymentController.getPaymentStatus));
router.get('/volume', asyncHandler(paymentController.getPaymentVolume));
router.get('/monthly-report', asyncHandler(paymentController.getMonthlyReport));
router.get('/overdue', asyncHandler(paymentController.getOverduePayments));
router.post('/send-reminders', asyncHandler(paymentController.sendReminders));

module.exports = router;