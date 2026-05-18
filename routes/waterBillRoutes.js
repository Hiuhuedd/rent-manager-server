// ============================================
// FILE: src/routes/waterBillRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const waterBillController = require('../controllers/waterBillController');

const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.use(authMiddleware);

// Save water bills for a property for a specific month
router.post('/:propertyId', asyncHandler(waterBillController.saveWaterBills));

// Get water bills for a property for a specific month
router.get('/:propertyId', asyncHandler(waterBillController.getWaterBills));

// Get water bill history for a property
router.get('/:propertyId/history', asyncHandler(waterBillController.getWaterBillHistory));

module.exports = router;
