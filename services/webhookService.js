
// ============================================
// FILE: src/services/webhookService.js
// ============================================
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const smsProcessor = require('../../smsProcessor');

class WebhookService {
  async processMpesaWebhook(webhookData) {
    console.log('📥 Incoming Webhook Data:', JSON.stringify(webhookData, null, 2));

    // Validate request payload
    if (!webhookData || !webhookData.body) {
      console.error('❌ No SMS message provided in the request body');
      return {
        success: false,
        status: 400,
        message: 'SMS message body is required',
        receivedBody: webhookData,
      };
    }

    // Parse the SMS message
    const parsedSMS = smsProcessor.parseMpesaWebhook(webhookData);

    if (!parsedSMS.success) {
      console.warn('⚠️ Failed to parse SMS:', parsedSMS.error);
      return {
        success: false,
        status: 400,
        message: 'Invalid SMS message format',
        error: parsedSMS.error,
        rawBody: webhookData.body,
      };
    }

    const {
      transactionId,
      accountNumber,
      amount,
      date,
      payerName,
      paymentMethod,
    } = parsedSMS.data;

    console.log(`✅ Payment parsed: ${payerName} paid KSh ${amount} for ${accountNumber}`);

    // Check for duplicate payment
    const paymentRef = doc(db, 'rental_payments', transactionId);
    const paymentSnap = await getDoc(paymentRef);

    if (paymentSnap.exists()) {
      console.warn(`⚠️ Duplicate transaction: ${transactionId} already recorded`);
      return {
        success: false,
        status: 409,
        message: `Transaction ${transactionId} already processed`,
        transactionId,
      };
    }

    // Process payment
    console.log(`🔍 Searching for tenant using accountNumber: ${accountNumber}`);

    const paymentResult = await smsProcessor.processRentalPayment({
      ...parsedSMS.data,
      phoneToMatch: accountNumber,
    });

    if (!paymentResult.success) {
      console.error('❌ Failed to process rental payment:', paymentResult.error);
      return {
        success: false,
        status: 400,
        message: 'Payment processing failed',
        error: paymentResult.error,
        houseNumber: accountNumber,
      };
    }

    // Store payment record in Firestore
    await setDoc(paymentRef, {
      ...parsedSMS.data,
      status: 'processed',
      timestamp: new Date().toISOString(),
    });

    console.log('✅ Payment saved successfully in Firestore.');
    console.log('🎉 Webhook completed successfully:', JSON.stringify(paymentResult, null, 2));

    return {
      success: true,
      data: paymentResult,
    };
  }
}

module.exports = new WebhookService();