// ============================================
// FILE: src/routes/settingsRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');

// GET /api/settings - Get application settings
router.get('/', settingsController.getSettings.bind(settingsController));

// PUT /api/settings - Update application settings
router.put('/', settingsController.updateSettings.bind(settingsController));

module.exports = router;
