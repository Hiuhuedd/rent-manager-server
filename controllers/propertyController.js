  
// ============================================
// FILE: src/controllers/propertyController.js
// ============================================
const propertyService = require('../services/propertyService');
const { createSuccessResponse } = require('../utils/responseHelper');

class PropertyController {
  async getAllProperties(req, res) {
    const properties = await propertyService.getAllProperties();
    res.json(properties);
  }

  async getPropertyById(req, res) {
    const property = await propertyService.getPropertyById(req.params.id);
    
    if (!property) {
      return res.status(404).json({
        success: false,
        error: 'Property not found'
      });
    }
    
    res.json(createSuccessResponse(property));
  }

  async createProperty(req, res) {
    const result = await propertyService.createProperty(req.body);
    res.json(createSuccessResponse(result, 'Property created successfully'));
  }

  async updateProperty(req, res) {
    const result = await propertyService.updateProperty(req.params.id, req.body);
    
    if (!result) {
      return res.status(404).json({
        success: false,
        error: 'Property not found'
      });
    }
    
    res.json(createSuccessResponse(result, 'Property updated successfully'));
  }
}

module.exports = new PropertyController();