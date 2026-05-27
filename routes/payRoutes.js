const express = require('express');
const router  = express.Router();
const { initiateStk, stkCallback, checkStatus } = require('../controllers/payController');

// Trigger STK push for rent payment
router.post('/stk', initiateStk);

// Safaricom fires this after processing the STK push
router.post('/stk-callback', stkCallback);

// Frontend polls this to get payment status
router.get('/status/:checkoutId', checkStatus);

module.exports = router;
