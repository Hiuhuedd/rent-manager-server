  

// ============================================
// FILE: src/middleware/errorHandler.js
// ============================================
const { createErrorResponse } = require('../utils/responseHelper');

const errorHandler = (err, req, res, next) => {
  console.error('🔥 Error:', err.stack || err);
  
  const status = err.status || 500;
  const message = err.message || 'Internal server error';
  
  res.status(status).json(
    createErrorResponse(status, message, {
      error: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    })
  );
};

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = {
  errorHandler,
  asyncHandler
};