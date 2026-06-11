  
// ============================================
// FILE: src/services/smsService.js
// ============================================

const SMSService = require('../smsService');

// Re-export the SMS service methods
module.exports = {
  sendSMS: (phone, message, contextId, contextData, debtId) => 
    SMSService.sendSMS(phone, message, contextId, contextData, debtId),
  
  generateInvoiceSMS: (debt, phone) => 
    SMSService.generateInvoiceSMS(debt, phone),
  
  generatePaymentConfirmationSMS: (debt, amount, referenceNumber, resultData) => 
    SMSService.generatePaymentConfirmationSMS(debt, amount, referenceNumber, resultData),
  
  generateTenantWelcomeSMS: (tenantData, paymentInfo) => 
    SMSService.generateTenantWelcomeSMS(tenantData, paymentInfo),
};
 