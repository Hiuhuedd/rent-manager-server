  
// ============================================
// FILE: src/routes/propertyRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const propertyController = require('../controllers/propertyController');
const { validatePropertyInput } = require('../middleware/validator');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/', asyncHandler(propertyController.getAllProperties));
router.get('/:id', asyncHandler(propertyController.getPropertyById));
router.post('/', validatePropertyInput, asyncHandler(propertyController.createProperty));
router.put('/:id', validatePropertyInput, asyncHandler(propertyController.updateProperty));

module.exports = router;