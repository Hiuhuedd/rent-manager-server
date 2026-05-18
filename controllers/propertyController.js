// ============================================
// FILE: src/controllers/propertyController.js
// ============================================
const propertyService = require('../services/propertyService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class PropertyController {
  async getAllProperties(req, res) {
    const { agencyId, assignedProperties, role, uid } = req.user;
    const properties = await propertyService.getAllProperties(
      agencyId, 
      role === 'admin' ? null : assignedProperties,
      role === 'admin' ? null : uid
    );
    res.json(properties);
  }

  async getPropertyById(req, res) {
    try {
      const { agencyId } = req.user;
      const property = await propertyService.getPropertyById(req.params.id, agencyId);

      if (!property) {
        return res.status(404).json(createErrorResponse('Property not found'));
      }

      res.json(createSuccessResponse(property));
    } catch (error) {
      res.status(403).json(createErrorResponse(error.message));
    }
  }

  async createProperty(req, res) {
    try {
      const { agencyId, uid } = req.user;
      const result = await propertyService.createProperty(agencyId, uid, req.body);
      res.json(createSuccessResponse(result, 'Property created successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async updateProperty(req, res) {
    try {
      const { agencyId } = req.user;
      const result = await propertyService.updateProperty(req.params.id, req.body, agencyId);

      if (!result) {
        return res.status(404).json(createErrorResponse('Property not found'));
      }

      res.json(createSuccessResponse(result, 'Property updated successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async updateUnit(req, res) {
    const { id, unitId } = req.params;
    const { agencyId } = req.user;
    const result = await propertyService.updateUnit(id, unitId, req.body, agencyId);
    res.json(createSuccessResponse(result, 'Unit updated successfully'));
  }

  async deleteProperty(req, res) {
    try {
      const { agencyId } = req.user;
      await propertyService.deleteProperty(req.params.id, agencyId);
      res.json(createSuccessResponse({ success: true }, 'Property deleted successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }
}

module.exports = new PropertyController();