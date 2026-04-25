// ============================================
// FILE: src/routes/electricityBillRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const electricityBillController = require('../controllers/electricityBillController');

// Save electricity bills for a property for a specific month
router.post('/:propertyId', electricityBillController.saveElectricityBills);

// Get electricity bills for a property for a specific month
router.get('/:propertyId', electricityBillController.getElectricityBills);

module.exports = router;
