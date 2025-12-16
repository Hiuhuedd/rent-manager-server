// ============================================
// FILE: src/controllers/runningCostController.js
// ============================================
const runningCostService = require('../services/runningCostService');
const { createSuccessResponse } = require('../utils/responseHelper');

class RunningCostController {
    async addCost(req, res) {
        const { propertyId, category, feeName, amount, description, date } = req.body;

        if (!propertyId || !category || !feeName || !amount) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: propertyId, category, feeName, amount'
            });
        }

        const result = await runningCostService.addCost({
            propertyId,
            category,
            feeName,
            amount,
            description,
            date,
            createdBy: req.user?.email || 'system', // If auth is enabled
        });

        res.json(createSuccessResponse(result, 'Running cost added successfully'));
    }

    async getCostsByProperty(req, res) {
        const { propertyId } = req.params;
        const costs = await runningCostService.getCostsByProperty(propertyId);
        res.json(createSuccessResponse({ costs }));
    }

    async getCostsByPropertyAndMonth(req, res) {
        const { propertyId, month } = req.params;
        const costs = await runningCostService.getCostsByPropertyAndMonth(propertyId, month);
        res.json(createSuccessResponse({ costs }));
    }

    async deleteCost(req, res) {
        const { id } = req.params;

        try {
            await runningCostService.deleteCost(id);
            res.json(createSuccessResponse({ success: true }, 'Cost deleted successfully'));
        } catch (error) {
            res.status(404).json({
                success: false,
                error: error.message
            });
        }
    }

    async getTotalCostsByMonth(req, res) {
        const { propertyId, month } = req.params;
        const totals = await runningCostService.getTotalCostsByMonth(propertyId, month);
        res.json(createSuccessResponse(totals));
    }
}

module.exports = new RunningCostController();
