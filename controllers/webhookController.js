const settingsService = require('../services/settingsService');
const manualPaymentService = require('../services/payment/manualPaymentService');
const dedicatedMpesaService = require('../services/payment/dedicatedMpesaService');
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



  // Daraja C2B Validation (Tier 2 & 3)
  async processDarajaValidation(req, res) {
    console.log('\n📩 === NEW DARAJA C2B VALIDATION ===');
    const payload = req.body;
    console.log(payload);

    try {
      const shortCode = payload.BusinessShortCode;
      
      let agencyId = await settingsService.findAgencyByShortCode(shortCode);
      if (!agencyId) {
        console.warn('❌ Dedicated M-Pesa Validation failed: shortcode not registered', shortCode);
        return res.status(200).json({ ResultCode: 1, ResultDesc: "Business Short Code not registered" });
      }

      const agencyConfig = await settingsService.getSettings(agencyId);
      const validationResult = await dedicatedMpesaService.processValidation(payload, agencyId, agencyConfig);

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

      let agencyId = await settingsService.findAgencyByShortCode(shortCode);
      if (!agencyId) {
        console.error('❌ Dedicated M-Pesa Confirmation failed: shortcode not registered', shortCode);
        return res.status(200).json({ ResultCode: 1, ResultDesc: "Business Short Code not registered" });
      }

      const agencyConfig = await settingsService.getSettings(agencyId);
      const confirmationResult = await dedicatedMpesaService.processConfirmation(payload, agencyId, agencyConfig);

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

  async processDarajaBalanceResult(req, res) {
    const { agencyId } = req.params;
    console.log(`\n📩 === DARAJA ACCOUNT BALANCE RESULT [Agency: ${agencyId}] ===`);
    const payload = req.body;
    console.log(JSON.stringify(payload, null, 2));

    try {
      const result = payload?.Result;
      const resultCode = result?.ResultCode;
      
      if (resultCode === 0 && result.ResultParameters && result.ResultParameters.ResultParameter) {
        const params = result.ResultParameters.ResultParameter;
        const balanceParam = params.find(p => p.Key === 'AccountBalance');
        
        if (balanceParam && balanceParam.Value) {
          const balanceString = balanceParam.Value;
          // Example: Working Account|KES|125.00|125.00|0.00|0.00&Utility Account|KES|219.00|219.00|0.00|0.00
          const accounts = balanceString.split('&');
          let workingBalance = 0;
          let utilityBalance = 0;
          
          accounts.forEach(acc => {
            const parts = acc.split('|');
            if (parts.length >= 3) {
              const accountName = parts[0];
              const currentBalance = parseFloat(parts[2]);
              
              if (accountName.includes('Working Account')) {
                workingBalance = currentBalance;
              } else if (accountName.includes('Utility Account')) {
                utilityBalance = currentBalance;
              }
            }
          });
          
          console.log(`✅ [Balance Query] Successfully parsed balances for Agency ${agencyId}: Utility=${utilityBalance}, Working=${workingBalance}`);
          
          // Save to Firestore!
          const { db } = require('../config/firebase');
          const { doc, updateDoc } = require('firebase/firestore');
          const settingsRef = doc(db, 'settings', agencyId);
          await updateDoc(settingsRef, {
            'liveMpesaBalances.utility': utilityBalance,
            'liveMpesaBalances.working': workingBalance,
            'liveMpesaBalances.isLive': true,
            'liveMpesaBalances.lastSynced': new Date().toISOString()
          });
        }
      } else {
        console.warn(`⚠️ [Balance Query] FAILED or missing parameters - Code: ${resultCode}`);
      }

      // Acknowledge Safaricom
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
    } catch (err) {
      console.error('❌ Account Balance Result callback crash:', err.message);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
    }
  }

  async processDarajaBalanceTimeout(req, res) {
    const { agencyId } = req.params;
    console.log(`\n⏰ === DARAJA ACCOUNT BALANCE TIMEOUT [Agency: ${agencyId}] ===`);
    return res.status(200).json({ ResultCode: 0, ResultDesc: 'Received' });
  }
}

module.exports = new WebhookController();