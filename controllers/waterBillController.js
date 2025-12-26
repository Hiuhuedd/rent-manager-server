// ============================================
// FILE: src/controllers/waterBillController.js
// ============================================
const waterBillService = require('../services/waterBillService');

class WaterBillController {
    /**
     * Save water bills for a property for a specific month
     * POST /api/water-bills/:propertyId
     * Body: { month: 'YYYY-MM', bills: [...] }
     */
    async saveWaterBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month, bills } = req.body;

            if (!bills || !Array.isArray(bills) || bills.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Bills array is required and must not be empty',
                });
            }

            const result = await waterBillService.saveWaterBills(propertyId, month, bills);

            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            console.error('Error saving water bills:', error);
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    }

    /**
     * Get water bills for a property for a specific month
     * GET /api/water-bills/:propertyId?month=YYYY-MM
     */
    async getWaterBills(req, res) {
        try {
            const { propertyId } = req.params;
            const { month } = req.query;

            const result = await waterBillService.getWaterBills(propertyId, month);

            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            console.error('Error getting water bills:', error);
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    }

    /**
     * Get water bill history for a property
     * GET /api/water-bills/:propertyId/history
     */
    async getWaterBillHistory(req, res) {
        try {
            const { propertyId } = req.params;

            const result = await waterBillService.getWaterBillHistory(propertyId);

            res.status(200).json({
                success: true,
                data: result,
            });
        } catch (error) {
            console.error('Error getting water bill history:', error);
            res.status(500).json({
                success: false,
                error: error.message,
            });
        }
    }
}

module.exports = new WaterBillController();
