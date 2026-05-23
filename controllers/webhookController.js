  
// ============================================
// FILE: src/controllers/webhookController.js
// ============================================
const webhookService = require('../services/webhookService');

class WebhookController {
  async processMpesaWebhook(req, res) {
    console.log('\n📩 === NEW M-PESA SMS WEBHOOK RECEIVED ===');
    
    const result = await webhookService.processMpesaWebhook(req.body);
    
    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    
    res.status(200).json({
      success: true,
      message: 'Rental payment processed successfully',
      payment: result.data
    });
  }

  async processDarajaValidation(req, res) {
    console.log('\n📩 === NEW DARAJA C2B VALIDATION ===');
    console.log(req.body);
    
    // Always accept the transaction by default for now
    res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Accepted"
    });
  }

  async processDarajaConfirmation(req, res) {
    console.log('\n📩 === NEW DARAJA C2B CONFIRMATION ===');
    console.log(req.body);

    // TODO: Implement confirmation logic (Commission split & Ledger update)

    res.status(200).json({
      ResultCode: 0,
      ResultDesc: "Success"
    });
  }
}

module.exports = new WebhookController();