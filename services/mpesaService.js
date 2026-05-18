// ============================================
// FILE: src/services/mpesaService.js
// ============================================
const axios = require('axios');
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const smsQuotaService = require('./smsQuotaService');

// Daraja M-Pesa Credentials provided by user
const DARAJA_CONSUMER_KEY = 'ogNIHgP7LRN2LjGuKb7ShvCGM6xUHuKubEiiGnmddnNwl7CF';
const DARAJA_CONSUMER_SECRET = 'blg5AHGBAYzV40oJwfeR9pwByUlQb4nj055x8DfwAJzspOq1bRSlaQafuAkgYB5A';
const DARAJA_SHORTCODE = '6723519';
const DARAJA_PASSKEY = 'd61bb261124f727cfad44a8a00708452d517ba453519926f06c102abc298a44f';
const DARAJA_PARTY_B = '4123906'; // Till Number / Buy Goods PartyB

/**
 * Generate standard YYYYMMDDHHmmss timestamp
 */
const getTimestamp = () => {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}${hours}${minutes}${seconds}`;
};

class MpesaService {
  /**
   * Request OAuth Access Token from Safaricom Daraja
   */
  async getAccessToken() {
    const url = 'https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials';
    const auth = 'Basic ' + Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString('base64');

    try {
      console.log('🔑 Requesting M-Pesa access token from Safaricom...');
      const response = await axios.get(url, {
        headers: { Authorization: auth }
      });
      return response.data.access_token;
    } catch (error) {
      console.error('❌ M-Pesa OAuth generating token failed:', error.response ? error.response.data : error.message);
      throw new Error('Failed to generate M-Pesa access token');
    }
  }

  /**
   * Initiate M-Pesa STK Push
   */
  async initiateStkPush({ agencyId, amount, phone, type, planId, units, callbackBaseUrl }) {
    try {
      const accessToken = await this.getAccessToken();
      const url = 'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
      const auth = `Bearer ${accessToken}`;
      const timestamp = getTimestamp();
      
      // Password generation: ShortCode + PassKey + Timestamp
      const password = Buffer.from(
        `${DARAJA_SHORTCODE}${DARAJA_PASSKEY}${timestamp}`
      ).toString('base64');

      // Normalize phone number to Safaricom 254XXXXXXXXX format
      let formattedPhone = phone.trim().replace(/\+/g, '');
      if (formattedPhone.startsWith('0')) {
        formattedPhone = '254' + formattedPhone.substring(1);
      } else if (formattedPhone.startsWith('7') || formattedPhone.startsWith('1')) {
        formattedPhone = '254' + formattedPhone;
      }

      // Dynamic Callback URL formation. We prioritize BACKEND_URL (for custom local tunnels e.g., Ngrok)
      // or RENDER_EXTERNAL_URL (automatically populated by Render for your Web Service).
      let baseUrl = process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || callbackBaseUrl;
      
      // Clean trailing slashes if present
      if (baseUrl && baseUrl.endsWith('/')) {
        baseUrl = baseUrl.slice(0, -1);
      }
      
      const callbackUrl = `${baseUrl}/api/billing/mpesa-callback`;

      console.log(`📱 Initiating STK push for ${formattedPhone} of KSh ${amount}...`);
      
      const payload = {
        BusinessShortCode: DARAJA_SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerBuyGoodsOnline',
        Amount: Math.round(parseFloat(amount)),
        PartyA: formattedPhone,
        PartyB: DARAJA_PARTY_B,
        PhoneNumber: formattedPhone,
        CallBackURL: callbackUrl,
        AccountReference: 'KodiPay Systems',
        TransactionDesc: `KodiPay Checkout ${type}`
      };

      const response = await axios.post(url, payload, {
        headers: { Authorization: auth }
      });

      const { CheckoutRequestID, MerchantRequestID, ResponseCode, CustomerMessage } = response.data;

      if (ResponseCode === '0') {
        console.log(`✅ STK push successfully requested. CheckoutRequestID: ${CheckoutRequestID}`);
        
        // Save pending checkout in Firestore
        await setDoc(doc(db, 'mpesa_checkouts', CheckoutRequestID), {
          CheckoutRequestID,
          MerchantRequestID,
          agencyId,
          type, // 'sms' or 'subscription'
          planId: planId || null,
          units: units ? parseInt(units) : 0,
          amount: parseFloat(amount),
          phone: formattedPhone,
          status: 'pending',
          createdAt: new Date().toISOString()
        });

        return {
          success: true,
          checkoutRequestId: CheckoutRequestID,
          message: CustomerMessage || 'Request successful. Please enter your M-Pesa PIN on your phone.'
        };
      } else {
        throw new Error('Daraja process request rejected');
      }
    } catch (error) {
      console.error('❌ M-Pesa STK push failed:', error.response ? error.response.data : error.message);
      return {
        success: false,
        error: error.response ? error.response.data.errorMessage || error.response.data : error.message
      };
    }
  }

  /**
   * Process incoming Safaricom STK Push Callback receipt
   */
  async processCallback(callbackPayload) {
    try {
      console.log('📥 Processing Daraja callback payload:', JSON.stringify(callbackPayload, null, 2));

      if (!callbackPayload || !callbackPayload.Body || !callbackPayload.Body.stkCallback) {
        throw new Error('Invalid callback payload structure');
      }

      const { stkCallback } = callbackPayload.Body;
      const { CheckoutRequestID, ResultCode, ResultDesc } = stkCallback;

      // Find the corresponding checkout in Firestore
      const checkoutRef = doc(db, 'mpesa_checkouts', CheckoutRequestID);
      const checkoutSnap = await getDoc(checkoutRef);

      if (!checkoutSnap.exists()) {
        console.error(`❌ M-Pesa Checkout not found for request ID: ${CheckoutRequestID}`);
        return { success: false, error: 'Checkout session not found' };
      }

      const checkout = checkoutSnap.data();

      // If already processed, skip
      if (checkout.status !== 'pending') {
        console.log(`⚠️ Callback already processed for ${CheckoutRequestID}. Current status: ${checkout.status}`);
        return { success: true, message: 'Already processed' };
      }

      if (ResultCode === 0) {
        // SUCCESSFUL TRANSACTION
        const metadataItems = stkCallback.CallbackMetadata.Item || [];
        const amountItem = metadataItems.find(item => item.Name === 'Amount') || {};
        const receiptItem = metadataItems.find(item => item.Name === 'MpesaReceiptNumber') || {};
        const phoneItem = metadataItems.find(item => item.Name === 'PhoneNumber') || {};

        const paidAmount = amountItem.Value || checkout.amount;
        const mpesaReceiptNumber = receiptItem.Value || '';
        const payerPhone = phoneItem.Value || checkout.phone;

        // 1. Update Checkout Status to Completed
        await updateDoc(checkoutRef, {
          status: 'completed',
          mpesaReceiptNumber,
          paidAmount,
          payerPhone,
          resultDesc: ResultDesc,
          completedAt: new Date().toISOString()
        });

        // 2. Provision the purchased item for the Agency
        const agencyRef = doc(db, 'agencies', checkout.agencyId);

        if (checkout.type === 'sms') {
          // SMS Bundle Provisioning
          const stats = await smsQuotaService.getQuotaStats(checkout.agencyId);
          const newLimit = (stats.monthlyLimit || 0) + parseInt(checkout.units);
          await smsQuotaService.updateLimit(checkout.agencyId, newLimit);
          console.log(`🎉 Success: SMS bundle of ${checkout.units} units successfully credited to Agency ${checkout.agencyId}`);
        } else if (checkout.type === 'subscription') {
          // Plan Subscription Provisioning
          let propertiesLimit = 75;
          let unitsLimit = 800;
          let smsLimit = 1500;

          if (checkout.planId === 'growth') {
            propertiesLimit = 150;
            unitsLimit = 2500;
            smsLimit = 5000;
          } else if (checkout.planId === 'professional') {
            propertiesLimit = 500;
            unitsLimit = 10000;
            smsLimit = 15000;
          }

          await updateDoc(agencyRef, {
            'subscription.activePlan': checkout.planId,
            'subscription.status': 'active',
            'subscription.updatedAt': new Date().toISOString(),
            'smsStats.monthlyLimit': smsLimit,
            'subscription.propertiesLimit': propertiesLimit,
            'subscription.unitsLimit': unitsLimit
          });
          console.log(`🎉 Success: Subscription Plan '${checkout.planId}' successfully activated for Agency ${checkout.agencyId}`);
        }

        return { success: true, message: 'Payment successfully captured and plan provisioned' };
      } else {
        // FAILED OR CANCELLED TRANSACTION
        await updateDoc(checkoutRef, {
          status: 'failed',
          resultCode: ResultCode,
          resultDesc: ResultDesc,
          failedAt: new Date().toISOString()
        });

        console.warn(`⚠️ STK push payment failed for checkout ${CheckoutRequestID}: ${ResultDesc}`);
        return { success: false, error: ResultDesc };
      }
    } catch (error) {
      console.error('❌ Error processing Daraja callback:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new MpesaService();
