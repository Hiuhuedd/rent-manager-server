// ============================================
// FILE: src/routes/electricityBillRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const electricityBillController = require('../controllers/electricityBillController');

const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

router.use(authMiddleware);

// Save electricity bills for a property for a specific month
router.post('/:propertyId', asyncHandler(electricityBillController.saveElectricityBills));

// Get electricity bills for a property for a specific month
router.get('/:propertyId', asyncHandler(electricityBillController.getElectricityBills));

module.exports = router;
