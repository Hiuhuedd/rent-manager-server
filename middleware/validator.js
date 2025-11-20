  
// ============================================
// FILE: src/middleware/validator.js
// ============================================
const validateTenantInput = (req, res, next) => {
  const { name, unitCode, phone } = req.body;
  
  if (!name || !unitCode || !phone) {
    return res.status(400).json({
      success: false,
      error: 'Name, unitCode, and phone are required'
    });
  }
  
  next();
};

const validatePropertyInput = (req, res, next) => {
  const { propertyName, units } = req.body;
  
  if (!propertyName || typeof propertyName !== 'string') {
    return res.status(400).json({
      success: false,
      error: 'Property name is required and must be a string'
    });
  }
  
  if (!Array.isArray(units) || units.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Units array is required and cannot be empty'
    });
  }
  
  next();
};

module.exports = {
  validateTenantInput,
  validatePropertyInput
};