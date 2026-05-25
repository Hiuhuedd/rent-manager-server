const settingsService = require('../services/settingsService');
const manualPaymentService = require('../services/payment/manualPaymentService');
const dedicatedMpesaService = require('../services/payment/dedicatedMpesaService');
const kodipayPaybillService = require('../services/payment/kodipayPaybillService');
const axios = require('axios');

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

  // Auto-Register Daraja Webhook URLs from the Remote Server IP
  async registerUrls(req, res) {
    try {
      const isProd = process.env.KODIPAY_MASTER_ENV === 'production';
      const baseUrl = isProd ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

      const consumerKey = process.env.KODIPAY_MASTER_CONSUMER_KEY;
      const consumerSecret = process.env.KODIPAY_MASTER_CONSUMER_SECRET;
      const shortCode = process.env.KODIPAY_MASTER_SHORTCODE;

      if (!consumerKey || !consumerSecret || !shortCode) {
        return res.status(400).json({ success: false, error: "Missing KODIPAY_MASTER credentials in .env" });
      }

      // 1. Get Access Token
      const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
      const tokenResponse = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
        headers: { Authorization: `Basic ${auth}` }
      });
      const accessToken = tokenResponse.data.access_token;

      // 2. Register URLs
      const payload = {
        ShortCode: shortCode,
        ResponseType: 'Completed',
        ConfirmationURL: 'https://rent-manager-server.onrender.com/api/webhook/gateway/confirmation',
        ValidationURL: 'https://rent-manager-server.onrender.com/api/webhook/gateway/validation'
      };

      const registerResponse = await axios.post(`${baseUrl}/mpesa/c2b/v2/registerurl`, payload, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });

      return res.status(200).json({
        success: true,
        message: "Daraja Webhooks Registered Successfully!",
        data: registerResponse.data
      });



    } catch (error) {

      console.error("❌ FULL ERROR:", JSON.stringify(error.response?.data, null, 2));
      console.error("❌ STATUS:", error.response?.status);
      console.error("❌ HEADERS:", error.response?.headers);
      console.error("❌ REGISTRATION FAILED FROM SERVER:", error.response?.data || error.message);
      return res.status(500).json({
        success: false,
        error: "Registration failed",
        details: error.response?.data || error.message
      });
    }
  }

  // Daraja C2B Validation (Tier 2 & 3)
  async processDarajaValidation(req, res) {
    console.log('\n📩 === NEW DARAJA C2B VALIDATION ===');
    const payload = req.body;
    console.log(payload);

    try {
      const shortCode = payload.BusinessShortCode;
      const isGoldenPaybill = shortCode === '4005473' || shortCode === process.env.KODIPAY_MASTER_SHORTCODE;

      let agencyId = null;
      let agencyConfig = null;

      if (isGoldenPaybill) {
        agencyId = await settingsService.findAgencyByTenantPhone(payload.BillRefNumber);
        if (!agencyId) {
          console.warn('❌ Golden Paybill Validation failed: unregistered tenant phone used as account number', payload.BillRefNumber);
          return res.status(200).json({ ResultCode: 1, ResultDesc: "Invalid account number" });
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
      const isGoldenPaybill = shortCode === '4005473' || shortCode === process.env.KODIPAY_MASTER_SHORTCODE;

      let agencyId = null;
      let agencyConfig = null;

      if (isGoldenPaybill) {
        agencyId = await settingsService.findAgencyByTenantPhone(payload.BillRefNumber);
        if (!agencyId) {
          console.error('❌ Golden Paybill Confirmation failed: unregistered tenant phone used as account number', payload.BillRefNumber);
          return res.status(200).json({ ResultCode: 1, ResultDesc: "Invalid account number" });
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

  // B2C / B2B Payout Result Callback (Safaricom fires this after processing the payout)
  async processDarajaResult(req, res) {
    console.log('\n📩 === B2C/B2B PAYOUT RESULT CALLBACK ===');
    const payload = req.body;
    console.log(JSON.stringify(payload, null, 2));

    try {
      const result = payload?.Result;
      const resultCode = result?.ResultCode;
      const resultDesc = result?.ResultDesc;
      const conversationId = result?.ConversationID;
      const origConversationId = result?.OriginatorConversationID;
      const transactionId = result?.TransactionID;

      if (resultCode === 0) {
        console.log(`✅ [Payout Result] SUCCESS - ConversationID: ${conversationId}, TransactionID: ${transactionId}`);
      } else {
        console.warn(`⚠️ [Payout Result] FAILED - Code: ${resultCode}, Desc: ${resultDesc}, ConversationID: ${origConversationId}`);
      }

      // Acknowledge Safaricom immediately
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
    } catch (err) {
      console.error('❌ B2C/B2B Result callback crash:', err.message);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
    }
  }

  // B2C / B2B Payout Timeout Callback (Safaricom fires this if no response was received in time)
  async processDarajaTimeout(req, res) {
    console.log('\n⏰ === B2C/B2B PAYOUT QUEUE TIMEOUT CALLBACK ===');
    const payload = req.body;
    console.log(JSON.stringify(payload, null, 2));

    const conversationId = payload?.Result?.OriginatorConversationID || payload?.ConversationID || 'UNKNOWN';
    console.warn(`⚠️ [Payout Timeout] Payout timed out in Safaricom queue. ConversationID: ${conversationId}. Manual investigation may be required.`);

    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  }
}

module.exports = new WebhookController();