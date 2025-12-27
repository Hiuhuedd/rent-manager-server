// ============================================
// FILE: src/routes/reportRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { asyncHandler } = require('../middleware/errorHandler');

router.get('/property/:propertyId/month/:month', asyncHandler(reportController.generatePropertyReport));
router.get('/property/:propertyId/month/:month/pdf', asyncHandler(reportController.downloadReportPdf));
router.get('/portfolio/month/:month/pdf', asyncHandler(reportController.downloadPortfolioReportPdf));

module.exports = router;
