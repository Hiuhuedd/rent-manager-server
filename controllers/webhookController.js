const settingsService = require('../services/settingsService');
const manualPaymentService = require('../services/payment/manualPaymentService');
const dedicatedMpesaService = require('../services/payment/dedicatedMpesaService');
const kodipayPaybillService = require('../services/payment/kodipayPaybillService');

class WebhookController {
  // SMS Webhook (Manual Tier 1)
  async processMpesaWebhook(req, res) {
    console.log('\n📩 === NEW M-PESA SMS WEBHOOK RECEIVED ===');
    const result = await manualPaymentService.processMpesaWebhook(req.body);
    if (!result.success) {
      return res.status(result.status || 400).json(result);
    }
    res.status(200).json({
      success: true,
      message: 'Rental payment processed successfully',
      payment: result.data
    });
  }

  // Daraja C2B Validation (Tier 2 & 3)
  async processDarajaValidation(req, res) {
    console.log('\n📩 === NEW DARAJA C2B VALIDATION ===');
    const payload = req.body;
    console.log(payload);

    try {
      const shortCode = payload.BusinessShortCode;
      const isGoldenPaybill = shortCode === '4005473';

      let agencyId = null;
      let agencyConfig = null;

      if (isGoldenPaybill) {
        agencyId = await settingsService.findAgencyByPrefix(payload.BillRefNumber);
        if (!agencyId) {
          console.warn('❌ Golden Paybill Validation failed: invalid prefix for account', payload.BillRefNumber);
          return res.status(200).json({ ResultCode: 1, ResultDesc: "Invalid account code prefix" });
        }
      } else {
        agencyId = await settingsService.findAgencyByShortCode(shortCode);
        if (!agencyId) {
          console.warn('❌ Dedicated M-Pesa Validation failed: shortcode not registered', shortCode);
          return res.status(200).json({ ResultCode: 1, ResultDesc: "Business Short Code not registered" });
        }
      }

      agencyConfig = await settingsService.getSettings(agencyId);
      
      let validationResult;
      if (isGoldenPaybill) {
        validationResult = await kodipayPaybillService.processValidation(payload, agencyId, agencyConfig);
      } else {
        validationResult = await dedicatedMpesaService.processValidation(payload, agencyId, agencyConfig);
      }

      return res.status(200).json(validationResult);

    } catch (err) {
      console.error('❌ Validation processing crash:', err.message);
      return res.status(200).json({ ResultCode: 1, ResultDesc: "Internal validation failure" });
    }
  }

  // Daraja C2B Confirmation (Tier 2 & 3)
  async processDarajaConfirmation(req, res) {
    console.log('\n📩 === NEW DARAJA C2B CONFIRMATION ===');
    const payload = req.body;
    console.log(payload);

    try {
      const shortCode = payload.BusinessShortCode;
      const isGoldenPaybill = shortCode === '4005473';

      let agencyId = null;
      let agencyConfig = null;

      if (isGoldenPaybill) {
        agencyId = await settingsService.findAgencyByPrefix(payload.BillRefNumber);
        if (!agencyId) {
          console.error('❌ Golden Paybill Confirmation failed: invalid prefix for account', payload.BillRefNumber);
          return res.status(200).json({ ResultCode: 1, ResultDesc: "Invalid account code prefix" });
        }
      } else {
        agencyId = await settingsService.findAgencyByShortCode(shortCode);
        if (!agencyId) {
          console.error('❌ Dedicated M-Pesa Confirmation failed: shortcode not registered', shortCode);
          return res.status(200).json({ ResultCode: 1, ResultDesc: "Business Short Code not registered" });
        }
      }

      agencyConfig = await settingsService.getSettings(agencyId);

      let confirmationResult;
      if (isGoldenPaybill) {
        confirmationResult = await kodipayPaybillService.processConfirmation(payload, agencyId, agencyConfig);
      } else {
        confirmationResult = await dedicatedMpesaService.processConfirmation(payload, agencyId, agencyConfig);
      }

      if (!confirmationResult.success) {
        return res.status(200).json({ ResultCode: 1, ResultDesc: confirmationResult.error || "Confirmation processing failed" });
      }

      return res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });

    } catch (err) {
      console.error('❌ Confirmation processing crash:', err.message);
      return res.status(200).json({ ResultCode: 1, ResultDesc: "Internal confirmation failure" });
    }
  }
}

module.exports = new WebhookController();