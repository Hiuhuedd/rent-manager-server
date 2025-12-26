// ============================================
// FILE: src/routes/waterBillRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const waterBillController = require('../controllers/waterBillController');

// Save water bills for a property for a specific month
router.post('/:propertyId', waterBillController.saveWaterBills);

// Get water bills for a property for a specific month
router.get('/:propertyId', waterBillController.getWaterBills);

// Get water bill history for a property
router.get('/:propertyId/history', waterBillController.getWaterBillHistory);

module.exports = router;
