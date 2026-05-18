  
// ============================================
// FILE: src/middleware/logger.js
// ============================================
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logMessage = `[${new Date().toLocaleTimeString()}] ${req.method} ${req.originalUrl || req.path} - ${res.statusCode} [${duration}ms]`;
    
    if (res.statusCode >= 400) {
      console.log(`❌ ${logMessage}`);
    } else {
      console.log(`✅ ${logMessage}`);
    }
  });
  
  next();
};

module.exports = { requestLogger };