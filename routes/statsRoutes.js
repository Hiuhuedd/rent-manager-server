// ============================================
// FILE: src/routes/statsRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', asyncHandler(statsController.getStats));

module.exports = router;