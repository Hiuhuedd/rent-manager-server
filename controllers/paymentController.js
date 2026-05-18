// ============================================
// FILE: src/controllers/paymentController.js
// ============================================
const paymentService = require('../services/paymentService');
const manualPaymentProcessor = require('../manualPaymentProcessor');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class PaymentController {
    /**
     * Process a manual payment
     * POST /api/payments/manual
     */
    async processManualPayment(req, res) {
        const { 
            tenantId, amount, paymentMethod, paymentDate, paymentMonth, note,
            transactionCode, bankName, phoneNumber, receiptNumber, chequeNumber, chequeDate
        } = req.body;
        if (!req.user || !req.user.agencyId) {
            return res.status(401).json(createErrorResponse('Unauthorized: Missing agency context'));
        }
        const agencyId = req.user.agencyId;

        if (!tenantId || !amount) {
            return res.status(400).json(createErrorResponse('tenantId and amount are required'));
        }

        const result = await manualPaymentProcessor.processManualPayment({
            tenantId,
            amount: parseFloat(amount),
            paymentMethod,
            paymentDate,
            paymentMonth,
            note,
            transactionCode,
            bankName,
            phoneNumber,
            receiptNumber,
            chequeNumber,
            chequeDate,
            agencyId // Pass agencyId
        });

        if (result.success) {
            res.status(200).json(createSuccessResponse(result.data, 'Manual payment processed successfully'));
        } else {
            res.status(500).json(createErrorResponse(result.error));
        }
    }

  /**
   * Get payment status for all units in a specific month
   * GET /api/payments/status?month=2024-11
   */
  async getPaymentStatus(req, res) {
    const { month } = req.query;
    if (!req.user || !req.user.agencyId) {
      return res.status(401).json(createErrorResponse('Unauthorized: Missing agency context'));
    }
    const { agencyId, assignedProperties, role } = req.user;
    
    let filterProperties = role === 'admin' ? null : (assignedProperties || []);
    if (role === 'admin' && req.query.propertyIds !== undefined) {
      filterProperties = req.query.propertyIds ? req.query.propertyIds.split(',') : [];
    }

    const status = await paymentService.getPaymentStatus(
      agencyId, 
      month,
      filterProperties
    );

    res.status(200).json({
      success: true,
      data: status,
      metadata: {
        month: month || new Date().toISOString().slice(0, 7),
        totalUnits: status?.length || 0,
        paidUnits: (status || []).filter(s => s.status === 'Paid').length,
        unpaidUnits: (status || []).filter(s => s.status === 'Unpaid').length,
        vacantUnits: (status || []).filter(s => s.status === 'Vacant').length
      }
    });
  }

  /**
   * Get payment volume by property for a specific month
   * GET /api/payments/volume?month=2024-11
   */
  async getPaymentVolume(req, res) {
    const { month } = req.query;
    if (!req.user || !req.user.agencyId) {
      return res.status(401).json(createErrorResponse('Unauthorized: Missing agency context'));
    }
    const { agencyId, assignedProperties, role } = req.user;
    
    let filterProperties = role === 'admin' ? null : (assignedProperties || []);
    if (role === 'admin' && req.query.propertyIds !== undefined) {
      filterProperties = req.query.propertyIds ? req.query.propertyIds.split(',') : [];
    }

    const volume = await paymentService.getPaymentVolume(
      agencyId, 
      month,
      filterProperties
    );

    const totalVolume = (volume || []).reduce((sum, v) => sum + (v.total || 0), 0);
    const totalPayments = (volume || []).reduce((sum, v) => sum + (v.paymentCount || 0), 0);

    res.status(200).json({
      success: true,
      data: volume,
      metadata: {
        month: month || new Date().toISOString().slice(0, 7),
        totalProperties: volume?.length || 0,
        totalVolume,
        totalPayments,
        averagePerProperty: (volume?.length || 0) > 0 ? (totalVolume / volume.length).toFixed(2) : 0
      }
    });
  }

  /**
   * Get comprehensive monthly report
   * GET /api/payments/monthly-report?month=2024-11
   */
  async getMonthlyReport(req, res) {
    const { month } = req.query;
    if (!req.user || !req.user.agencyId) {
      return res.status(401).json(createErrorResponse('Unauthorized: Missing agency context'));
    }
    const { agencyId, assignedProperties, role } = req.user;
    
    let filterProperties = role === 'admin' ? null : (assignedProperties || []);
    if (role === 'admin' && req.query.propertyIds !== undefined) {
      filterProperties = req.query.propertyIds ? req.query.propertyIds.split(',') : [];
    }

    const report = await paymentService.getMonthlyReport(
      agencyId, 
      month,
      filterProperties
    );

    // Add collection rate with defensive checks
    const totalExpected = report?.summary?.totalExpected || 0;
    const totalReceived = report?.summary?.totalReceived || 0;
    
    const collectionRate = totalExpected > 0
      ? ((totalReceived / totalExpected) * 100).toFixed(2)
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
    if (!req.user || !req.user.agencyId) {
      return res.status(401).json(createErrorResponse('Unauthorized: Missing agency context'));
    }
    const { agencyId, assignedProperties, role } = req.user;
    
    let filterProperties = role === 'admin' ? null : (assignedProperties || []);
    if (role === 'admin' && req.query.propertyIds !== undefined) {
      filterProperties = req.query.propertyIds ? req.query.propertyIds.split(',') : [];
    }

    const overdueData = await paymentService.getOverduePayments(
      agencyId, 
      month,
      filterProperties
    );

    const totalOverdue = (overdueData?.tenants || []).reduce((sum, t) => sum + (t.remainingAmount || 0), 0);

    res.status(200).json({
      success: true,
      data: overdueData,
      metadata: {
        totalOverdueAmount: totalOverdue,
        count: overdueData?.count || 0,
        partialPayments: (overdueData?.tenants || []).filter(t => t.status === 'partial').length,
        completelyUnpaid: (overdueData?.tenants || []).filter(t => t.status === 'unpaid').length
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
    if (!req.user || !req.user.agencyId) {
      return res.status(401).json(createErrorResponse('Unauthorized: Missing agency context'));
    }
    const { agencyId, assignedProperties, role } = req.user;
    const result = await paymentService.sendReminders(
      agencyId, 
      month, 
      tenantIds,
      role === 'admin' ? null : (assignedProperties || [])
    );

    res.status(200).json({
      success: true,
      data: result,
      metadata: {
        successRate: (result?.sent || 0) > 0
          ? `${((result.sent / (result.sent + (result.failed || 0))) * 100).toFixed(2)}%`
          : '0%',
        timestamp: new Date().toISOString()
      }
    });
  }
}

module.exports = new PaymentController();