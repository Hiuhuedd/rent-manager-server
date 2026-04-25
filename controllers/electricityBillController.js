// ============================================
// FILE: src/controllers/electricityBillController.js
// ============================================
const electricityBillService = require('../services/electricityBillService');

class ElectricityBillController {
    /**
     * Save electricity bills for a property for a specific month
     * POST /api/electricity-bills/:propertyId
     */
    async saveElectricityBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month, bills } = req.body;

            if (!bills || !Array.isArray(bills) || bills.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Bills array is required and must not be empty',
                });
            }

            const result = await electricityBillService.saveElectricityBills(propertyId, month, bills);

            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            console.error('Error saving electricity bills:', error);
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    }

    /**
     * Get electricity bills for a property for a specific month
     * GET /api/electricity-bills/:propertyId?month=YYYY-MM
     */
    async getElectricityBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month } = req.query;

            const result = await electricityBillService.getElectricityBills(propertyId, month);

            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            console.error('Error getting electricity bills:', error);
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    }
}

module.exports = new ElectricityBillController();
