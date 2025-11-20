  
// ============================================
// FILE: src/utils/responseHelper.js
// ============================================
const createSuccessResponse = (data, message = 'Success') => ({
  success: true,
  message,
  data
});

const createErrorResponse = (status, message, details = {}, originalData = null) => ({
  success: false,
  error: {
    message,
    code: status,
    details: process.env.NODE_ENV === 'development' ? details : undefined,
    originalData
  }
});

module.exports = {
  createSuccessResponse,
  createErrorResponse
};