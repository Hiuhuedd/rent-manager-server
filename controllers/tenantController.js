  
// ============================================
// FILE: src/controllers/tenantController.js
// ============================================
const tenantService = require('../services/tenantService');
const { createSuccessResponse } = require('../utils/responseHelper');

class TenantController {
  async getAllTenants(req, res) {
    const tenants = await tenantService.getAllTenants();
    res.json(tenants);
  }

  async getTenantById(req, res) {
    const tenant = await tenantService.getTenantById(req.params.id);
    
    if (!tenant) {
      return res.status(404).json({
        success: false,
        error: 'Tenant not found'
      });
    }
    
    res.json({ id: tenant.id, ...tenant });
  }

  async getPaymentStatus(req, res) {
    const status = await tenantService.getPaymentStatus(req.params.id);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Tenant not found'
      });
    }
    
    res.json(createSuccessResponse(status));
  }

  async createTenant(req, res) {
    const result = await tenantService.createTenant(req.body);
    res.json(createSuccessResponse(result, 'Tenant created successfully'));
  }

  async deleteTenant(req, res) {
    const result = await tenantService.deleteTenant(req.params.tenantId);
    res.json(createSuccessResponse(result, 'Tenant deleted successfully'));
  }

  async sendReminder(req, res) {
    const result = await tenantService.sendReminder(req.params.id);
    res.json(createSuccessResponse(result, 'Reminder sent'));
  }

  async sendConfirmation(req, res) {
    const result = await tenantService.sendConfirmation(req.params.id, req.body.amount);
    res.json(createSuccessResponse(result, 'Confirmation sent'));
  }
}

module.exports = new TenantController();