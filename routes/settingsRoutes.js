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

module.exports = router;
