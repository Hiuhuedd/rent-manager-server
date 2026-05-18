const smsQuotaService = require('../services/smsQuotaService');
const mpesaService = require('../services/mpesaService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');
const { db } = require('../config/firebase');
const { doc, getDoc } = require('firebase/firestore');

class BillingController {
  /**
   * Get current SMS usage and quota
   */
  async getSmsUsage(req, res) {
    try {
      const { agencyId } = req.user;
      const stats = await smsQuotaService.getQuotaStats(agencyId);
      res.json(createSuccessResponse(stats));
    } catch (error) {
      res.status(500).json(createErrorResponse('Failed to fetch SMS usage', error.message));
    }
  }

  /**
   * Simulate purchasing an SMS plan (legacy / mock fallback)
   */
  async purchasePlan(req, res) {
    try {
      const { agencyId } = req.user;
      const { planId, units } = req.body;

      if (!units) return res.status(400).json(createErrorResponse('Units required'));

      const stats = await smsQuotaService.getQuotaStats(agencyId);
      const newLimit = (stats.monthlyLimit || 0) + parseInt(units);
      
      await smsQuotaService.updateLimit(agencyId, newLimit);

      res.json(createSuccessResponse({
        newLimit,
        planId,
        purchasedUnits: units
      }, 'SMS plan activated successfully'));
    } catch (error) {
      res.status(500).json(createErrorResponse('Failed to purchase plan', error.message));
    }
  }

  /**
   * Initiate live M-Pesa STK Push for billing plans/bundles
   */
  async initiateMpesaStk(req, res) {
    try {
      const { agencyId } = req.user;
      const { phone, amount, type, planId, units } = req.body;

      if (!phone || !amount || !type) {
        return res.status(400).json(createErrorResponse('Phone number, amount, and payment type are required'));
      }

      // Determine dynamic callback base url from the request's protocol and host
      const callbackBaseUrl = `${req.protocol}://${req.get('host')}`;

      const stkResult = await mpesaService.initiateStkPush({
        agencyId,
        phone,
        amount,
        type, // 'sms' or 'subscription'
        planId,
        units,
        callbackBaseUrl
      });

      if (!stkResult.success) {
        return res.status(400).json(createErrorResponse(stkResult.error || 'M-Pesa payment initiation failed'));
      }

      res.json(createSuccessResponse(stkResult, 'M-Pesa payment request sent successfully. Please check your phone.'));
    } catch (error) {
      res.status(500).json(createErrorResponse('M-Pesa initiation failed internally', error.message));
    }
  }

  /**
   * Public webhook receiver for Safaricom STK Push Callbacks
   */
  async processMpesaCallback(req, res) {
    try {
      console.log('📡 Webhook: Received Safaricom STK push callback...');
      const processResult = await mpesaService.processCallback(req.body);

      // M-Pesa API expects a 200 response indicating receipt of webhook
      res.status(200).json({
        success: processResult.success,
        message: processResult.message || processResult.error || 'Callback processed'
      });
    } catch (error) {
      console.error('❌ Callback webhook error:', error.message);
      res.status(200).json({ success: false, error: error.message });
    }
  }
}

module.exports = new BillingController();
