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

  /**
   * Generate tenant welcome SMS with deposit information
   * @param {Object} tenantData - Tenant information
   * @param {string} tenantData.name - Tenant's full name
   * @param {string} tenantData.unitCode - Unit ID
   * @param {number} tenantData.rentAmount - Monthly rent amount
   * @param {number} tenantData.utilityFees - Total utility fees
   * @param {number} tenantData.totalAmount - Total monthly charges
   * @param {number} tenantData.depositAmount - Security deposit amount
   * @param {Object} paymentInfo - Payment details
   * @param {string} paymentInfo.paybill - Paybill number
   * @param {string} paymentInfo.accountNumber - Account number for payment
   * @returns {string} Formatted welcome SMS message
   */
  generateTenantWelcomeSMS(tenantData, paymentInfo) {
    console.log('🏠 Generating tenant welcome SMS...');
    console.log(`   - Tenant Name: ${tenantData.name}`);
    console.log(`   - Unit Code: ${tenantData.unitCode}`);
    console.log(`   - Rent Amount: ${tenantData.rentAmount}`);
    console.log(`   - Utility Fees: ${tenantData.utilityFees || 0}`);
    console.log(`   - Total Monthly: ${tenantData.totalAmount}`);
    console.log(`   - Deposit Amount: ${tenantData.depositAmount || 0}`);

    const rentAmount = tenantData.rentAmount || 0;
    const utilityFees = tenantData.utilityFees || 0;
    const totalAmount = tenantData.totalAmount || rentAmount;
    const depositAmount = tenantData.depositAmount || 0;

    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    const paybill = paymentInfo.paybill;
    const accountNumber = paymentInfo.accountNumber;

    let message;

    // Build message based on deposit and utilities
    if (depositAmount > 0) {
      // With deposit
      if (utilityFees > 0) {
        // Deposit + Utilities
        message = `Welcome ${tenantData.name}! Unit ${tenantData.unitCode}. ` +
                  `Rent ${formatAmount(rentAmount)} + Utils ${formatAmount(utilityFees)} = ${formatAmount(totalAmount)}/mo. ` +
                  `DEPOSIT: ${formatAmount(depositAmount)} (one-time). ` +
                  `1st Payment: ${formatAmount(totalAmount + depositAmount)}. ` +
                  `Paybill ${paybill}, Acc ${accountNumber}. Due 1st. Call 0113689071`;
      } else {
        // Deposit only, no utilities
        message = `Welcome ${tenantData.name}! Unit ${tenantData.unitCode}. ` +
                  `Rent KSH ${formatAmount(totalAmount)}/mo. ` +
                  `DEPOSIT: ${formatAmount(depositAmount)} (one-time, refundable). ` +
                  `1st Payment: ${formatAmount(totalAmount + depositAmount)}. ` +
                  `Pay: Paybill ${paybill}, Acc ${accountNumber}. Due 1st. Info: 0113689071`;
      }
    } else {
      // No deposit
      if (utilityFees > 0) {
        // Utilities only, no deposit
        message = `Welcome ${tenantData.name}! Unit ${tenantData.unitCode}. ` +
                  `Rent ${formatAmount(rentAmount)} + Utils ${formatAmount(utilityFees)} = ${formatAmount(totalAmount)}/mo. ` +
                  `Paybill ${paybill}, Acc ${accountNumber}. Due 1st. Call 0113689071`;
      } else {
        // Simple message - no utilities, no deposit
        message = `Welcome ${tenantData.name}! Unit ${tenantData.unitCode} ready. ` +
                  `Rent KSH ${formatAmount(totalAmount)}/month. ` +
                  `Pay: Paybill ${paybill}, Acc ${accountNumber}. Due 1st. Info: 0113689071`;
      }
    }

    console.log('✅ Welcome SMS generated successfully');
    console.log(`   - Message length: ${message.length} characters`);
    console.log(`   - Message preview: ${message.substring(0, 100)}...`);

    if (message.length > 160) {
      console.warn(`⚠️ Message exceeds 160 characters (${message.length}), will be split into multiple SMS`);
    }

    return message;
  }

  /**
   * Generate deposit reminder SMS
   * @param {Object} tenantData - Tenant information
   * @param {string} tenantData.name - Tenant's name
   * @param {number} tenantData.depositAmount - Deposit amount
   * @param {string} tenantData.unitCode - Unit ID
   * @param {Object} paymentInfo - Payment details
   * @returns {string} Deposit reminder message
   */
  generateDepositReminderSMS(tenantData, paymentInfo) {
    console.log('💰 Generating deposit reminder SMS...');
    
    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    const message = `Hello ${tenantData.name}, ` +
                    `Outstanding deposit for Unit ${tenantData.unitCode}: KSH ${formatAmount(tenantData.depositAmount)}. ` +
                    `Pay: Paybill ${paymentInfo.paybill}, Acc ${paymentInfo.accountNumber}. ` +
                    `Contact: 0113689071`;

    console.log('✅ Deposit reminder SMS generated');
    console.log(`   - Message length: ${message.length} characters`);
    
    return message;
  }

  /**
   * Generate deposit confirmation SMS
   * @param {Object} tenantData - Tenant information
   * @param {string} tenantData.name - Tenant's name
   * @param {number} tenantData.depositAmount - Deposit amount paid
   * @param {string} tenantData.unitCode - Unit ID
   * @param {string} paidDate - Date of payment (formatted)
   * @returns {string} Deposit confirmation message
   */
  generateDepositConfirmationSMS(tenantData, paidDate) {
    console.log('✅ Generating deposit confirmation SMS...');
    
    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    const message = `Thank you ${tenantData.name}! ` +
                    `Deposit CONFIRMED for Unit ${tenantData.unitCode}. ` +
                    `Amount: KSH ${formatAmount(tenantData.depositAmount)}. ` +
                    `Date: ${paidDate}. ` +
                    `Refundable at lease end. Welcome home!`;

    console.log('✅ Deposit confirmation SMS generated');
    console.log(`   - Message length: ${message.length} characters`);
    
    return message;
  }

  /**
   * Generate rent reminder SMS with deposit status
   * @param {Object} tenantData - Tenant information
   * @param {Object} paymentInfo - Payment details
   * @param {boolean} hasOutstandingDeposit - Whether deposit is still pending
   * @returns {string} Rent reminder message
   */
  generateRentReminderSMS(tenantData, paymentInfo, hasOutstandingDeposit = false) {
    console.log('📅 Generating rent reminder SMS...');
    
    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    let message = `Hello ${tenantData.name}, ` +
                  `Rent reminder for Unit ${tenantData.unitCode}. ` +
                  `Amount due: KSH ${formatAmount(tenantData.totalAmount)}. `;

    if (hasOutstandingDeposit) {
      message += `PLUS Outstanding deposit: ${formatAmount(tenantData.depositAmount)}. `;
    }

    message += `Due: 1st. Pay: Paybill ${paymentInfo.paybill}, Acc ${paymentInfo.accountNumber}. ` +
               `Call 0113689071`;

    console.log('✅ Rent reminder SMS generated');
    console.log(`   - Message length: ${message.length} characters`);
    console.log(`   - Has outstanding deposit: ${hasOutstandingDeposit}`);
    
    return message;
  }

  /**
   * Generate move-out SMS with deposit refund info
   * @param {Object} tenantData - Tenant information
   * @param {number} refundAmount - Amount to be refunded
   * @param {number} deductions - Deductions from deposit
   * @param {string} reason - Reason for deductions (if any)
   * @returns {string} Move-out message
   */
  generateMoveOutSMS(tenantData, refundAmount, deductions = 0, reason = '') {
    console.log('🚪 Generating move-out SMS...');
    
    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    let message = `Hello ${tenantData.name}, ` +
                  `Move-out confirmed for Unit ${tenantData.unitCode}. `;

    if (deductions > 0) {
      message += `Deposit: ${formatAmount(tenantData.depositAmount)}. ` +
                 `Deductions: ${formatAmount(deductions)}`;
      if (reason) {
        message += ` (${reason})`;
      }
      message += `. Refund: ${formatAmount(refundAmount)}. `;
    } else {
      message += `Full deposit refund: KSH ${formatAmount(refundAmount)}. `;
    }

    message += `Processed in 7 days. Thank you!`;

    console.log('✅ Move-out SMS generated');
    console.log(`   - Message length: ${message.length} characters`);
    
    return message;
  }

  /**
   * Generate payment confirmation SMS
   * @param {Object} tenantData - Tenant information
   * @param {number} amount - Amount paid
   * @param {string} type - Payment type ('rent', 'deposit', 'utilities')
   * @param {string} referenceNumber - Transaction reference
   * @returns {string} Payment confirmation message
   */
  generatePaymentConfirmationSMS(tenantData, amount, type, referenceNumber) {
    console.log('💳 Generating payment confirmation SMS...');
    
    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    const typeMap = {
      'rent': 'Rent',
      'deposit': 'Deposit',
      'utilities': 'Utilities',
      'other': 'Payment'
    };

    const paymentType = typeMap[type] || 'Payment';

    const message = `Payment received! ` +
                    `${paymentType}: KSH ${formatAmount(amount)}. ` +
                    `Unit: ${tenantData.unitCode}. ` +
                    `Ref: ${referenceNumber}. ` +
                    `Thank you ${tenantData.name}!`;

    console.log('✅ Payment confirmation SMS generated');
    console.log(`   - Message length: ${message.length} characters`);
    
    return message;
  }

  /**
   * Send SMS via TextSMS API
   * @param {string} to - Recipient's phone number
   * @param {string} message - SMS message content
   * @param {string} userId - User ID for logging
   * @param {string} debtId - Debt/Tenant ID for logging
   * @returns {Promise<Object>} SMS result with success status and messageId
   */
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
        console.warn(`⚠️ Message length exceeds 160 characters (${message.length}), it will be split into multiple SMS`);
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

  /**
   * Log SMS to Firestore
   * @param {Object} smsData - SMS data to log
   * @returns {Promise<void>}
   */
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