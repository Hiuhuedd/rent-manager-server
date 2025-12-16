// ============================================
// FILE: src/controllers/reportController.js
// ============================================
const reportService = require('../services/reportService');
const { createSuccessResponse } = require('../utils/responseHelper');

class ReportController {
    async generatePropertyReport(req, res) {
        const { propertyId, month } = req.params;

        if (!propertyId || !month) {
            return res.status(400).json({
                success: false,
                error: 'Property ID and Month (YYYY-MM) are required'
            });
        }

        const report = await reportService.generatePropertyReport(propertyId, month);
        res.json(createSuccessResponse(report));
    }
}

module.exports = new ReportController();
