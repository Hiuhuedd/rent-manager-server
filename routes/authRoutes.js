const express = require('express');
const router = express.Router();
console.log('🔐 Auth Routes Registering...');
const authController = require('../controllers/authController');
const { asyncHandler } = require('../middleware/errorHandler');

router.post('/send-verification', asyncHandler(authController.sendVerification));
router.post('/verify-otp', asyncHandler(authController.verifyOtp));
router.post('/complete-signup', asyncHandler(authController.completeSignup));

module.exports = router;
