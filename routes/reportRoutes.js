// ============================================
// FILE: src/routes/reportRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const reportController = require('../controllers/reportController');
const { asyncHandler } = require('../middleware/errorHandler');

const { authMiddleware } = require('../middleware/auth');

router.use(authMiddleware);

router.get('/property/:propertyId/month/:month', asyncHandler(reportController.generatePropertyReport));
router.get('/property/:propertyId/month/:month/pdf', asyncHandler(reportController.downloadReportPdf));
router.get('/portfolio/month/:month', asyncHandler(reportController.generatePortfolioReport));
router.get('/portfolio/month/:month/pdf', asyncHandler(reportController.downloadPortfolioReportPdf));
router.get('/tenant/:tenantId', asyncHandler(reportController.getTenantStatement));
router.get('/tenant/:tenantId/pdf', asyncHandler(reportController.downloadTenantStatementPdf));

module.exports = router;
