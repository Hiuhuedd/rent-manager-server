// ============================================
// FILE: src/routes/settingsRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.use(authMiddleware);

// GET /api/settings - Get application settings
router.get('/', asyncHandler(settingsController.getSettings.bind(settingsController)));

// PUT /api/settings - Update application settings
router.put('/', asyncHandler(settingsController.updateSettings.bind(settingsController)));

// POST /api/settings/register-mpesa - Register custom Daraja Webhooks dynamically
router.post('/register-mpesa', asyncHandler(settingsController.registerMpesaWebhooks.bind(settingsController)));

// POST /api/settings/sync-mpesa-balances - Query Safaricom Account Balance API
// GET /api/settings/mpesa-balances - Retrieve live M-Pesa balances
router.get('/mpesa-balances', asyncHandler(settingsController.getMpesaBalances.bind(settingsController)));

module.exports = router;
