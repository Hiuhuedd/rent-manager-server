// ============================================
// FILE: src/controllers/statsController.js
// ============================================
const statsService = require('../services/statsService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class StatsController {
  async getStats(req, res) {
    try {
      // Extract month from query parameters (format: YYYY-MM)
      const month = req.query.month;
      
      // Validate month format if provided
      if (month && !/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      console.log(`[CONTROLLER] Getting stats for month: ${month || 'current'}`);
      
      const stats = await statsService.getStats(month);
      
      res.json(createSuccessResponse(stats));
    } catch (error) {
      console.error('[ERROR] Failed to get stats:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch stats', error.message)
      );
    }
  }

  async getStatsHistory(req, res) {
    try {
      const months = req.query.months || 6; // Default to 6 months
      const currentDate = new Date();
      const history = [];

      for (let i = 0; i < months; i++) {
        const targetDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
        const month = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
        
        const stats = await statsService.getStats(month);
        history.push(stats);
      }

      res.json(createSuccessResponse({ history }));
    } catch (error) {
      console.error('[ERROR] Failed to get stats history:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch stats history', error.message)
      );
    }
  }
}

module.exports = new StatsController();