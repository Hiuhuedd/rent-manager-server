  
// ============================================
// FILE: src/services/smsService.js
// ============================================
const SMSService = require('../../smsService');

// Re-export the SMS service methods
module.exports = {
  sendSMS: (phone, message, contextId, contextData) => 
    SMSService.sendSMS(phone, message, contextId, contextData),
  
  generateInvoiceSMS: (debt, phone) => 
    SMSService.generateInvoiceSMS(debt, phone),
  
  generatePaymentConfirmationSMS: (debt, amount) => 
    SMSService.generatePaymentConfirmationSMS(debt, amount),
  
  generateTenantWelcomeSMS: (tenantData, paymentInfo) => 
    SMSService.generateTenantWelcomeSMS(tenantData, paymentInfo),
};
