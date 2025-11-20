// ============================================
// FILE: src/controllers/paymentController.js
// ============================================
const paymentService = require('../services/paymentService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class PaymentController {
  /**
   * Validate month format (YYYY-MM)
   */
  validateMonth(month) {
    if (!month) return true; // Allow null/undefined for current month
    return /^\d{4}-\d{2}$/.test(month);
  }

  async getPaymentStatus(req, res) {
    try {
      const month = req.query.month;
      
      if (!this.validateMonth(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      const status = await paymentService.getPaymentStatus(month);
      res.json(createSuccessResponse(status));
    } catch (error) {
      console.error('[ERROR] Failed to get payment status:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch payment status', error.message)
      );
    }
  }

  async getPaymentVolume(req, res) {
    try {
      const month = req.query.month;
      
      if (!this.validateMonth(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      const volume = await paymentService.getPaymentVolume(month);
      res.json(createSuccessResponse(volume));
    } catch (error) {
      console.error('[ERROR] Failed to get payment volume:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch payment volume', error.message)
      );
    }
  }

  async getMonthlyReport(req, res) {
    try {
      const month = req.query.month;
      
      if (!this.validateMonth(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      console.log(`[CONTROLLER] Getting monthly report for: ${month || 'current month'}`);
      
      const report = await paymentService.getMonthlyReport(month);
      res.json(createSuccessResponse(report));
    } catch (error) {
      console.error('[ERROR] Failed to get monthly report:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch monthly report', error.message)
      );
    }
  }

  async getOverduePayments(req, res) {
    try {
      const month = req.query.month;
      
      if (!this.validateMonth(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      const overdue = await paymentService.getOverduePayments(month);
      res.json(createSuccessResponse(overdue));
    } catch (error) {
      console.error('[ERROR] Failed to get overdue payments:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch overdue payments', error.message)
      );
    }
  }

  async getArrears(req, res) {
    try {
      const month = req.query.month;
      
      if (!this.validateMonth(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      const arrears = await paymentService.getArrears(month);
      res.json(createSuccessResponse(arrears));
    } catch (error) {
      console.error('[ERROR] Failed to get arrears:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch arrears', error.message)
      );
    }
  }

  async sendReminders(req, res) {
    try {
      const month = req.query.month;
      
      if (!this.validateMonth(month)) {
        return res.status(400).json(
          createErrorResponse('Invalid month format. Expected YYYY-MM')
        );
      }

      const result = await paymentService.sendReminders(month);
      res.json(createSuccessResponse(result));
    } catch (error) {
      console.error('[ERROR] Failed to send reminders:', error);
      res.status(500).json(
        createErrorResponse('Failed to send reminders', error.message)
      );
    }
  }

  async getPaymentHistory(req, res) {
    try {
      const months = parseInt(req.query.months) || 6; // Default 6 months
      const currentDate = new Date();
      const history = [];

      for (let i = 0; i < months; i++) {
        const targetDate = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
        const month = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
        
        const report = await paymentService.getMonthlyReport(month);
        history.push(report);
      }

      res.json(createSuccessResponse({ history }));
    } catch (error) {
      console.error('[ERROR] Failed to get payment history:', error);
      res.status(500).json(
        createErrorResponse('Failed to fetch payment history', error.message)
      );
    }
  }
}

module.exports = new PaymentController();