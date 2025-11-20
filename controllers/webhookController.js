  
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
}

module.exports = new WebhookController();