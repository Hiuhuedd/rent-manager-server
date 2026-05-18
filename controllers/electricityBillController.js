// ============================================
// FILE: src/controllers/electricityBillController.js
// ============================================
const electricityBillService = require('../services/electricityBillService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class ElectricityBillController {
    /**
     * Save electricity bills for a property for a specific month
     * POST /api/electricity-bills/:propertyId
     */
    async saveElectricityBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month, bills } = req.body;
            const { agencyId } = req.user;

            if (!bills || !Array.isArray(bills) || bills.length === 0) {
                return res.status(400).json(createErrorResponse('Bills array is required and must not be empty'));
            }

            const result = await electricityBillService.saveElectricityBills(propertyId, month, bills, agencyId);
            res.json(createSuccessResponse(result));
        } catch (error) {
            res.status(403).json(createErrorResponse(error.message));
        }
    }

    /**
     * Get electricity bills for a property for a specific month
     * GET /api/electricity-bills/:propertyId
     */
    async getElectricityBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month } = req.query;
            const { agencyId } = req.user;

            const result = await electricityBillService.getElectricityBills(propertyId, month, agencyId);
            res.json(createSuccessResponse(result));
        } catch (error) {
            res.status(403).json(createErrorResponse(error.message));
        }
    }
}

module.exports = new ElectricityBillController();
