// ============================================
// FILE: src/controllers/tenantController.js
// ============================================
const tenantService = require('../services/tenantService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class TenantController {
  async getAllTenants(req, res) {
    const { agencyId, assignedProperties, role } = req.user;
    const tenants = await tenantService.getAllTenants(
      agencyId,
      role === 'admin' ? [] : assignedProperties
    );
    res.json(tenants);
  }

  async getTenantById(req, res) {
    try {
      const { agencyId } = req.user;
      const tenant = await tenantService.getTenantById(req.params.id, agencyId);
      
      if (!tenant) {
        return res.status(404).json(createErrorResponse('Tenant not found'));
      }
      
      res.json(createSuccessResponse(tenant));
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  async getPaymentStatus(req, res) {
    const { agencyId } = req.user;
    const status = await tenantService.getPaymentStatus(req.params.id, agencyId);
    if (!status) {
      return res.status(404).json(createErrorResponse('Tenant not found'));
    }
    res.json(createSuccessResponse(status));
  }

  async createTenant(req, res) {
    const { agencyId } = req.user;
    const result = await tenantService.createTenant({ ...req.body, agencyId });
    res.json(createSuccessResponse(result, 'Tenant created successfully'));
  }

  async deleteTenant(req, res) {
    const { agencyId } = req.user;
    const result = await tenantService.deleteTenant(req.params.tenantId, agencyId);
    res.json(createSuccessResponse(result, 'Tenant deleted successfully'));
  }

  async sendReminder(req, res) {
    const { agencyId } = req.user;
    const result = await tenantService.sendReminder(req.params.id, agencyId);
    res.json(createSuccessResponse(result, 'Reminder sent'));
  }

  async sendConfirmation(req, res) {
    const { agencyId } = req.user;
    const result = await tenantService.sendConfirmation(req.params.id, req.body.amount, agencyId);
    res.json(createSuccessResponse(result, 'Confirmation sent'));
  }

  async applyPenalty(req, res) {
    const { agencyId } = req.user;
    const result = await tenantService.applyPenalty(req.params.id, agencyId);
    res.json(createSuccessResponse(result, 'Late penalty applied successfully'));
  }

  async removePenalty(req, res) {
    const { agencyId } = req.user;
    const result = await tenantService.removePenalty(req.params.id, agencyId);
    res.json(createSuccessResponse(result, 'Late penalty removed successfully'));
  }
}

module.exports = new TenantController();