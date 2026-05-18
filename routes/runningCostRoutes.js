// ============================================
// FILE: src/routes/runningCostRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const runningCostController = require('../controllers/runningCostController');
const { asyncHandler } = require('../middleware/errorHandler');

const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.post('/', asyncHandler(runningCostController.addCost));
router.post('/batch', asyncHandler(runningCostController.addCostsBatch));
router.get('/', asyncHandler(runningCostController.getAllCosts));
router.get('/property/:propertyId', asyncHandler(runningCostController.getCostsByProperty));
router.get('/property/:propertyId/month/:month', asyncHandler(runningCostController.getCostsByPropertyAndMonth));
router.get('/property/:propertyId/month/:month/total', asyncHandler(runningCostController.getTotalCostsByMonth));
router.put('/:id', asyncHandler(runningCostController.updateCost));
router.delete('/:id', asyncHandler(runningCostController.deleteCost));

module.exports = router;
