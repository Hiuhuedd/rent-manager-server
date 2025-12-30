// ============================================
// FILE: src/controllers/paymentController.js
// ============================================
const paymentService = require('../services/paymentService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class PaymentController {
  /**
   * Get payment status for all units in a specific month
   * GET /api/payments/status?month=2024-11
   */
  async getPaymentStatus(req, res) {
    const { month } = req.query;

    console.log(`📊 Request: Get payment status for ${month || 'current month'}`);

    const status = await paymentService.getPaymentStatus(month);

    res.status(200).json({
      success: true,
      data: status,
      metadata: {
        month: month || new Date().toISOString().slice(0, 7),
        totalUnits: status.length,
        paidUnits: status.filter(s => s.status === 'Paid').length,
        unpaidUnits: status.filter(s => s.status === 'Unpaid').length,
        vacantUnits: status.filter(s => s.status === 'Vacant').length
      }
    });
  }

  /**
   * Get payment volume by property for a specific month
   * GET /api/payments/volume?month=2024-11
   */
  async getPaymentVolume(req, res) {
    const { month } = req.query;

    console.log(`📊 Request: Get payment volume for ${month || 'current month'}`);

    const volume = await paymentService.getPaymentVolume(month);

    const totalVolume = volume.reduce((sum, v) => sum + v.total, 0);
    const totalPayments = volume.reduce((sum, v) => sum + (v.paymentCount || 0), 0);

    res.status(200).json({
      success: true,
      data: volume,
      metadata: {
        month: month || new Date().toISOString().slice(0, 7),
        totalProperties: volume.length,
        totalVolume,
        totalPayments,
        averagePerProperty: volume.length > 0 ? (totalVolume / volume.length).toFixed(2) : 0
      }
    });
  }

  /**
   * Get comprehensive monthly report
   * GET /api/payments/monthly-report?month=2024-11
   */
  async getMonthlyReport(req, res) {
    const { month } = req.query;

    console.log(`📊 Request: Generate monthly report for ${month || 'current month'}`);

    const report = await paymentService.getMonthlyReport(month);

    // Add collection rate
    const collectionRate = report.summary.totalExpected > 0
      ? ((report.summary.totalReceived / report.summary.totalExpected) * 100).toFixed(2)
      : 0;

    res.status(200).json({
      success: true,
      data: report,
      metadata: {
        collectionRate: `${collectionRate}%`,
        generatedAt: new Date().toISOString()
      }
    });
  }

  /**
   * Get overdue payments for a specific month
   * GET /api/payments/overdue?month=2024-11
   */
  async getOverduePayments(req, res) {
    const { month } = req.query;

    console.log(`📊 Request: Get overdue payments for ${month || 'current month'}`);

    const overdueData = await paymentService.getOverduePayments(month);

    const totalOverdue = overdueData.tenants.reduce((sum, t) => sum + t.remainingAmount, 0);
    const totalArrears = overdueData.tenants.reduce((sum, t) => sum + t.arrears, 0);

    res.status(200).json({
      success: true,
      data: overdueData,
      metadata: {
        totalOverdueAmount: totalOverdue,
        totalArrearsAmount: totalArrears,
        partialPayments: overdueData.tenants.filter(t => t.status === 'partial').length,
        completelyUnpaid: overdueData.tenants.filter(t => t.status === 'unpaid').length
      }
    });
  }

  /**
   * Send payment reminders to tenants with overdue payments
   * POST /api/payments/send-reminders
   * Body: { month: '2024-11' }
   */
  async sendReminders(req, res) {
    const { month, tenantIds } = req.body;

    console.log(`📱 Request: Send reminders for ${month || 'current month'}`);

    const result = await paymentService.sendReminders(month, tenantIds);

    res.status(200).json({
      success: true,
      data: result,
      metadata: {
        successRate: result.sent > 0
          ? `${((result.sent / (result.sent + result.failed)) * 100).toFixed(2)}%`
          : '0%',
        timestamp: new Date().toISOString()
      }
    });
  }

  /**
   * Get arrears summary
   * GET /api/payments/arrears?month=2024-11
   */
  async getArrears(req, res) {
    const { month } = req.query;

    console.log(`📊 Request: Get arrears for ${month || 'current month'}`);

    const arrearsData = await paymentService.getArrears(month);

    const totalArrears = arrearsData.arrears
      .filter(a => a.amount)
      .reduce((sum, a) => sum + a.amount, 0);

    const tenantsWithArrears = arrearsData.arrears.filter(a => a.tenant).length;

    res.status(200).json({
      success: true,
      data: arrearsData,
      metadata: {
        totalArrears,
        tenantsWithArrears,
        averageArrears: tenantsWithArrears > 0
          ? (totalArrears / tenantsWithArrears).toFixed(2)
          : 0
      }
    });
  }
}

module.exports = new PaymentController();