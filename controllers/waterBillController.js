// ============================================
// FILE: src/controllers/waterBillController.js
// ============================================
const waterBillService = require('../services/waterBillService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class WaterBillController {
    /**
     * Save water bills for a property for a specific month
     * POST /api/water-bills/:propertyId
     */
    async saveWaterBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month, bills } = req.body;
            const { agencyId } = req.user;

            if (!bills || !Array.isArray(bills) || bills.length === 0) {
                return res.status(400).json(createErrorResponse('Bills array is required and must not be empty'));
            }

            const result = await waterBillService.saveWaterBills(propertyId, month, bills, agencyId);
            res.json(createSuccessResponse(result));
        } catch (error) {
            res.status(403).json(createErrorResponse(error.message));
        }
    }

    /**
     * Get water bills for a property for a specific month
     * GET /api/water-bills/:propertyId
     */
    async getWaterBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month } = req.query;
            const { agencyId } = req.user;

            const result = await waterBillService.getWaterBills(propertyId, month, agencyId);
            res.json(createSuccessResponse(result));
        } catch (error) {
            res.status(403).json(createErrorResponse(error.message));
        }
    }

    /**
     * Get water bill history for a property
     * GET /api/water-bills/:propertyId/history
     */
    async getWaterBillHistory(req, res) {
        try {
            const { propertyId } = req.params;
            const { agencyId } = req.user;

            const result = await waterBillService.getWaterBillHistory(propertyId, agencyId);
            res.json(createSuccessResponse(result));
        } catch (error) {
            res.status(403).json(createErrorResponse(error.message));
        }
    }
}

module.exports = new WaterBillController();
