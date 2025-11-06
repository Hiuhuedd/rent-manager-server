const axios = require('axios');
const { getFirestoreApp } = require('./firebase');
const { collection, addDoc } = require('firebase/firestore');

class SMSService {
  constructor() {
    console.log('🚀 Initializing SMS Service...');
    this.db = getFirestoreApp();
    this.config = {
      apiKey: process.env.TEXTSMS_API_KEY,
      partnerID: process.env.TEXTSMS_PARTNER_ID,
      shortcode: process.env.TEXTSMS_SENDER_ID,
      apiUrl: 'https://sms.textsms.co.ke/api/services/sendsms/'
    };
    console.log('📋 SMS Service Configuration:');
    console.log(`   - API Key: ${this.config.apiKey ? '***CONFIGURED***' : 'NOT SET'}`);
    console.log(`   - Partner ID: ${this.config.partnerID || 'NOT SET'}`);
    console.log(`   - Sender ID: ${this.config.shortcode}`);
    if (!this.config.apiKey || !this.config.partnerID) {
      console.warn('⚠️ TextSMS credentials not configured');
    }
  }
// Add this method to the SMSService class in smsService.js

generateTenantWelcomeSMS(tenantData, paymentInfo) {
  console.log('🏠 Generating tenant welcome SMS...');
  console.log(`   - Tenant Name: ${tenantData.name}`);
  console.log(`   - Unit Code: ${tenantData.unitCode}`);
  console.log(`   - Rent Amount: ${tenantData.rentAmount}`);
  console.log(`   - Utility Fees: ${tenantData.utilityFees || 0}`);
  console.log(`   - Total Amount: ${tenantData.totalAmount}`);

  const rentAmount = tenantData.rentAmount || 0;
  const utilityFees = tenantData.utilityFees || 0;
  const totalAmount = tenantData.totalAmount || rentAmount;

  const formattedTotal = new Intl.NumberFormat('en-KE', {
    style: 'decimal',
    maximumFractionDigits: 0
  }).format(totalAmount);

  const paybill = paymentInfo.paybill ;
  const accountNumber = paymentInfo.accountNumber;

  // Build message based on whether utilities exist
  let message;
  
  if (utilityFees > 0) {
    // Include utility info if there are utility fees
    const formattedRent = new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(rentAmount);
    
    const formattedUtilities = new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(utilityFees);

    message = `Welcome ${tenantData.name}! Unit ${tenantData.unitCode}. Rent ${formattedRent} + Utils ${formattedUtilities} = ${formattedTotal}/mo. Paybill ${paybill}, Acc ${accountNumber}. Due 1st. Call 0113689071`;
  } else {
    // Simpler message without utilities
    message = `Welcome ${tenantData.name}! Unit ${tenantData.unitCode} ready. Rent KSH ${formattedTotal}/month. Pay: Paybill ${paybill}, Acc ${accountNumber}. Due 1st. Info: 0113689071`;
  }

  console.log('✅ Welcome SMS generated successfully');
  console.log(`   - Message length: ${message.length} characters`);
  console.log(`   - Message: ${message}`);

  if (message.length > 160) {
    console.warn('⚠️ Message exceeds 160 characters, may be split into multiple SMS');
  }

  return message;
}
  async sendSMS(to, message, userId, debtId) {
    console.log('📤 Attempting to send SMS...');
    console.log(`   - To: ${to}`);
    console.log(`   - Message Length: ${message.length}`);
    console.log(`   - Message: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);

    try {
      const formattedPhone = to.startsWith('+254') ? to.replace('+254', '254') :
                           to.startsWith('0') ? '254' + to.substring(1) : to;
      const formattedMessage = encodeURIComponent(message.trim());

      if (message.length > 160) {
        console.warn('⚠️ Message length exceeds 160 characters, it may be split');
      }

      const response = await axios.post(this.config.apiUrl, {
        apikey: this.config.apiKey,
        partnerID: this.config.partnerID,
        message: formattedMessage,
        shortcode: this.config.shortcode,
        mobile: formattedPhone
      });

      const result = response.data;
      console.log('📋 TextSMS Response:', result);

      await this.logSMS({
        userId,
        debtId,
        to,
        message,
        success: true,
        messageId: result.responses[0].messageid,
        timestamp: new Date()
      });

      return {
        success: true,
        messageId: result.responses[0].messageid,
        data: result.responses[0]
      };
    } catch (error) {
      console.error('❌ SMS Service Error:', {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status
      });

      await this.logSMS({
        userId,
        debtId,
        to,
        message,
        success: false,
        error: error.message,
        errorDetails: {
          status: error.response?.status,
          data: error.response?.data
        },
        timestamp: new Date()
      });

      return {
        success: false,
        error: error.message
      };
    }
  }


  async logSMS(smsData) {
    console.log('💾 Logging SMS to Firestore...');
    console.log(`   - User ID: ${smsData.userId}`);
    console.log(`   - Debt ID: ${smsData.debtId}`);
    console.log(`   - To: ${smsData.to}`);
    console.log(`   - Success: ${smsData.success}`);

    try {
      const smsLogsRef = collection(this.db, 'sms_logs');
      const startTime = Date.now();
      const docRef = await addDoc(smsLogsRef, {
        ...smsData,
        createdAt: new Date()
      });
      const duration = Date.now() - startTime;
      console.log(`✅ SMS Log created successfully in ${duration}ms`);
      console.log(`   - Document ID: ${docRef.id}`);
    } catch (error) {
      console.error('❌ Error logging SMS to Firestore:', error.message);
      console.error('❌ Full error details:', {
        name: error.name,
        message: error.message,
        code: error.code
      });
    }
  }




}

module.exports = new SMSService();