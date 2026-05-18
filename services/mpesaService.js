// ============================================
// FILE: src/services/mpesaService.js
// ============================================
const axios = require('axios');
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');
const smsQuotaService = require('./smsQuotaService');
const smsService = require('./smsService');
const emailService = require('./emailService');

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
      
      // If running locally without a tunnel, fall back to your live Render backend so Safaricom's validation passes
      if (!baseUrl || baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) {
        baseUrl = 'https://rent-manager-server.onrender.com';
      }
      
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

        // 3. Dispatch confirmation SMS receipt, thank you SMS, and Receipt Email
        try {
          const agencySnap = await getDoc(agencyRef);
          const agencyData = agencySnap.exists() ? agencySnap.data() : {};

          // Fetch Admin User details for SMS/Email
          let recipientEmail = agencyData.email || '';
          let recipientName = agencyData.name || 'Valued Partner';
          let recipientPhone = payerPhone || checkout.phone || agencyData.phone || '';

          const { query, collection, where, getDocs } = require('firebase/firestore');
          const usersQ = query(
            collection(db, 'users'),
            where('agencyId', '==', checkout.agencyId),
            where('role', '==', 'admin')
          );
          const usersSnap = await getDocs(usersQ);
          if (usersSnap.docs.length > 0) {
            const adminData = usersSnap.docs[0].data();
            if (adminData.email) recipientEmail = adminData.email;
            if (adminData.name) recipientName = adminData.name;
            if (adminData.phone) recipientPhone = adminData.phone;
          }

          // Ensure recipientPhone is formatted correctly for SMS dispatch
          let smsTargetPhone = recipientPhone.trim().replace(/\+/g, '');
          if (smsTargetPhone.startsWith('0')) {
            smsTargetPhone = '254' + smsTargetPhone.substring(1);
          } else if (smsTargetPhone.startsWith('7') || smsTargetPhone.startsWith('1')) {
            smsTargetPhone = '254' + smsTargetPhone;
          }

          let planName = 'Starter Plan';
          if (checkout.planId === 'growth') planName = 'Growth Plan';
          else if (checkout.planId === 'professional') planName = 'Professional Plan';

          let receiptMsg = '';
          let thankYouMsg = '';
          let emailHtml = '';
          let emailSubject = '';

          if (checkout.type === 'subscription') {
            const propertiesLimit = checkout.planId === 'growth' ? 150 : (checkout.planId === 'professional' ? 500 : 75);
            const unitsLimit = checkout.planId === 'growth' ? 2500 : (checkout.planId === 'professional' ? 10000 : 800);
            const smsLimit = checkout.planId === 'growth' ? 5000 : (checkout.planId === 'professional' ? 15000 : 1500);

            receiptMsg = `KodiPay Payment Confirmed!\nReceipt No: ${mpesaReceiptNumber}\nAmount: KSh ${paidAmount}\nPlan: ${planName}\nStatus: Activated successfully.\nThank you for choosing KodiPay.`;
            
            thankYouMsg = `Hi ${recipientName}, thank you for subscribing to KodiPay ${planName}! Your agency limits have been successfully upgraded (Properties: ${propertiesLimit}, Units: ${unitsLimit}, SMS: ${smsLimit}). We are thrilled to partner with you!`;

            emailSubject = `Payment Confirmed & Plan Activated - KodiPay`;
            emailHtml = `
              <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border: 1px solid #f0f0f0; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.02);">
                <div style="text-align: center; margin-bottom: 32px;">
                  <div style="display: inline-block; width: 56px; height: 56px; background-color: #0f172a; border-radius: 16px; line-height: 56px; color: white; font-size: 24px; font-weight: bold; text-align: center;">K</div>
                </div>
                <h2 style="color: #0f172a; text-align: center; font-size: 22px; font-weight: 800; margin-bottom: 8px; tracking: -0.02em;">Payment Receipt</h2>
                <p style="color: #64748b; text-align: center; font-size: 14px; line-height: 1.6; margin-bottom: 32px;">Hi ${recipientName}, thank you for your payment. Your KodiPay subscription plan has been successfully activated.</p>
                
                <div style="background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0; margin-bottom: 32px;">
                  <h3 style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 0 0 16px 0;">Transaction Details</h3>
                  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Plan Selected</td>
                      <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${planName}</td>
                    </tr>
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Amount Paid</td>
                      <td style="padding: 8px 0; color: #16a34a; font-weight: 800; text-align: right;">KSh ${parseFloat(paidAmount).toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">M-Pesa Receipt Number</td>
                      <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right; font-family: monospace;">${mpesaReceiptNumber}</td>
                    </tr>
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Account Limits</td>
                      <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${propertiesLimit} Properties / ${unitsLimit} Units</td>
                    </tr>
                  </table>
                </div>

                <div style="text-align: center; margin-bottom: 32px;">
                  <a href="https://rent-manager-server.onrender.com" style="display: inline-block; padding: 14px 32px; background-color: #007aff; color: white; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 13px; box-shadow: 0 4px 12px rgba(0,122,255,0.2);">Go to Dashboard</a>
                </div>
                
                <p style="color: #64748b; font-size: 13px; line-height: 1.6; text-align: center;">We are thrilled to partner with you. Let's make property management simple and stress-free!</p>
                <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
                  <p style="font-size: 11px; color: #94a3b8;">&copy; 2026 KodiPay Inc. All rights reserved.</p>
                </div>
              </div>
            `;
          } else {
            // SMS Topup Bundle
            receiptMsg = `KodiPay Payment Confirmed!\nReceipt No: ${mpesaReceiptNumber}\nAmount: KSh ${paidAmount}\nBundle: ${checkout.units} SMS Messages\nStatus: Credited successfully.\nThank you for choosing KodiPay.`;
            
            thankYouMsg = `Hi ${recipientName}, thank you for topping up your SMS units! ${checkout.units} SMS messages have been successfully added to your KodiPay balance. Happy messaging!`;

            emailSubject = `SMS Bundle Topup Confirmed - KodiPay`;
            emailHtml = `
              <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border: 1px solid #f0f0f0; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.02);">
                <div style="text-align: center; margin-bottom: 32px;">
                  <div style="display: inline-block; width: 56px; height: 56px; background-color: #0f172a; border-radius: 16px; line-height: 56px; color: white; font-size: 24px; font-weight: bold; text-align: center;">K</div>
                </div>
                <h2 style="color: #0f172a; text-align: center; font-size: 22px; font-weight: 800; margin-bottom: 8px; tracking: -0.02em;">Payment Receipt</h2>
                <p style="color: #64748b; text-align: center; font-size: 14px; line-height: 1.6; margin-bottom: 32px;">Hi ${recipientName}, thank you for your payment. Your SMS bundle has been credited to your balance.</p>
                
                <div style="background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0; margin-bottom: 32px;">
                  <h3 style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 0 0 16px 0;">Transaction Details</h3>
                  <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Bundle Purchased</td>
                      <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${checkout.units} SMS Messages</td>
                    </tr>
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Amount Paid</td>
                      <td style="padding: 8px 0; color: #16a34a; font-weight: 800; text-align: right;">KSh ${parseFloat(paidAmount).toLocaleString()}</td>
                    </tr>
                    <tr>
                      <td style="padding: 8px 0; color: #64748b; font-weight: 500;">M-Pesa Receipt Number</td>
                      <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right; font-family: monospace;">${mpesaReceiptNumber}</td>
                    </tr>
                  </table>
                </div>

                <div style="text-align: center; margin-bottom: 32px;">
                  <a href="https://rent-manager-server.onrender.com" style="display: inline-block; padding: 14px 32px; background-color: #007aff; color: white; text-decoration: none; border-radius: 12px; font-weight: 600; font-size: 13px; box-shadow: 0 4px 12px rgba(0,122,255,0.2);">Go to Dashboard</a>
                </div>
                
                <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
                  <p style="font-size: 11px; color: #94a3b8;">&copy; 2026 KodiPay Inc. All rights reserved.</p>
                </div>
              </div>
            `;
          }

          // 1. Send SMS 1: Receipt SMS
          if (smsTargetPhone) {
            console.log(`💬 Dispatching Receipt SMS to ${smsTargetPhone}...`);
            await smsService.sendSMS(smsTargetPhone, receiptMsg, checkout.agencyId, 'system');
          }

          // 2. Send SMS 2: Thank you / Welcome SMS
          if (smsTargetPhone) {
            console.log(`💬 Dispatching Thank-You SMS to ${smsTargetPhone}...`);
            await smsService.sendSMS(smsTargetPhone, thankYouMsg, checkout.agencyId, 'system');
          }

          // 3. Send Confirmation Email
          if (recipientEmail) {
            console.log(`📧 Dispatching Receipt Email to ${recipientEmail}...`);
            await emailService.sendEmail(recipientEmail, emailSubject, emailHtml);
          }
        } catch (notifyErr) {
          console.error('❌ Failed to dispatch payment receipt notifications:', notifyErr.message);
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
