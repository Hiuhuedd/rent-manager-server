// ============================================
// FILE: src/routes/statsRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const statsController = require('../controllers/statsController');
const { asyncHandler } = require('../middleware/errorHandler');
const { authMiddleware } = require('../middleware/auth');

router.get('/', authMiddleware, asyncHandler(statsController.getStats));

module.exports = router;