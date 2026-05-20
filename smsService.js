const axios = require('axios');
const { getFirestoreApp } = require('./firebase');
const { collection, addDoc, doc, setDoc, increment } = require('firebase/firestore');
const smsQuotaService = require('./services/smsQuotaService');

class SMSService {
  constructor() {
    console.log('🚀 Initializing SMS Service...');
    this.db = getFirestoreApp();
    this.config = {
      apiKey: process.env.TEXTSMS_API_KEY,
      partnerID: process.env.TEXTSMS_PARTNER_ID,
      shortcode: (process.env.TEXTSMS_SENDER_ID || '').replace(/['"\s]/g, ''),
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
   * @param {string} tenantData.unitName - Unit name (preferred over unitCode)
   * @param {number} tenantData.rentAmount - Monthly rent amount
   * @param {number} tenantData.utilityFees - Total utility fees
   * @param {number} tenantData.totalAmount - Total monthly charges
   * @param {number} tenantData.depositAmount - Security deposit amount
   * @param {string} tenantData.waterMeterType - Water meter type ('single' or 'individual')
   * @param {Object} paymentInfo - Payment details
   * @param {string} paymentInfo.paybill - Paybill number
   * @param {string} paymentInfo.accountNumber - Account number for payment
   * @returns {string} Formatted welcome SMS message
   */
  generateTenantWelcomeSMS(tenantData, paymentInfo) {
    console.log('🏠 Generating tenant welcome SMS...');
    console.log(`   - Tenant Name: ${tenantData.name}`);
    console.log(`   - Unit: ${tenantData.unitName || tenantData.unitCode}`);
    console.log(`   - Rent Amount: ${tenantData.rentAmount}`);
    console.log(`   - Utility Fees: ${tenantData.utilityFees || 0}`);
    console.log(`   - Total Monthly: ${tenantData.totalAmount}`);
    console.log(`   - Deposit Amount: ${tenantData.depositAmount || 0}`);
    console.log(`   - Water Meter Type: ${tenantData.waterMeterType || 'single'}`);

    const rentAmount = tenantData.rentAmount || 0;
    const waterMeterType = tenantData.waterMeterType || 'single';
    // For individual water meters, exclude only water fees, keep garbage/electricity/other fees
    const utilityFees = waterMeterType === 'individual' ? (tenantData.nonWaterUtilityFees || 0) : (tenantData.utilityFees || 0);
    const totalAmount = waterMeterType === 'individual' ? (rentAmount + (tenantData.nonWaterUtilityFees || 0)) : (tenantData.totalAmount || rentAmount);
    const depositAmount = tenantData.depositAmount || 0;
    const unitDisplay = tenantData.unitName || tenantData.unitCode;

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
        message = `Welcome ${tenantData.name}! Unit ${unitDisplay}. ` +
          `Rent ${formatAmount(rentAmount)} + Utils ${formatAmount(utilityFees)} = ${formatAmount(totalAmount)}/mo. ` +
          `DEPOSIT: ${formatAmount(depositAmount)} (one-time). ` +
          `1st Payment: ${formatAmount(totalAmount + depositAmount)}. ` +
          `Paybill ${paybill}, Acc ${accountNumber}. Due 1st.`;
      } else {
        // Deposit only, no utilities
        message = `Welcome ${tenantData.name}! Unit ${unitDisplay}. ` +
          `Rent KSH ${formatAmount(totalAmount)}/mo. ` +
          `DEPOSIT: ${formatAmount(depositAmount)} (one-time, refundable). ` +
          `1st Payment: ${formatAmount(totalAmount + depositAmount)}. ` +
          `Pay: Paybill ${paybill}, Acc ${accountNumber}. Due 1st.`;
      }
    } else {
      // No deposit
      if (utilityFees > 0) {
        // Utilities only, no deposit
        message = `Welcome ${tenantData.name}! Unit ${unitDisplay}. ` +
          `Rent ${formatAmount(rentAmount)} + Utils ${formatAmount(utilityFees)} = ${formatAmount(totalAmount)}/mo. ` +
          `Paybill ${paybill}, Acc ${accountNumber}. Due 1st.`;
      } else {
        // Simple message - no utilities, no deposit
        message = `Welcome ${tenantData.name}! Unit ${unitDisplay} ready. ` +
          `Rent KSH ${formatAmount(totalAmount)}/month. ` +
          `Pay: Paybill ${paybill}, Acc ${accountNumber}. Due 1st.`;
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

    const formatPhoneAsAccount = (phone) => {
      if (!phone) return 'Tenant Phone';
      let clean = phone.trim().replace(/\s+/g, '').replace(/\+/g, '');
      if (clean.startsWith('254')) {
        clean = '0' + clean.substring(3);
      }
      if (!clean.startsWith('0') && clean.length >= 9) {
        clean = '0' + clean;
      }
      return clean;
    };

    const message = `Hello ${tenantData.name}, ` +
      `Outstanding deposit for Unit ${tenantData.unitCode}: KSH ${formatAmount(tenantData.depositAmount)}. ` +
      `Pay: Paybill ${paymentInfo.paybill}, Acc ${formatPhoneAsAccount(paymentInfo.accountNumber)}.`;

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
   * Generate rent reminder/invoice SMS with deposit status
   * @param {Object} debt - Debt information
   * @param {string} debt.debtCode - Unit ID
   * @param {Object} debt.storeOwner - Tenant info (name)
   * @param {number} debt.remainingAmount - Total amount due
   * @param {Object} debt.breakdown - Optional breakdown of charges {rent, water, utilities, deposit}
   * @param {Object} paymentInfo - Payment credentials
   * @returns {string} Rent reminder message
   */
  generateInvoiceSMS(debt, paymentInfo) {
    console.log('📅 Generating invoice/reminder SMS...');

    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    const unitDisplay = debt.debtCode;
    const name = debt.storeOwner?.name || 'Tenant';
    const totalAmount = debt.remainingAmount || 0;
    const breakdown = debt.breakdown || {};

    let message = `Hello ${name}, ` +
      `Reminder for Unit ${unitDisplay}. ` +
      `Total due: KSH ${formatAmount(totalAmount)}. `;

    if (breakdown.rent > 0 || breakdown.water > 0 || breakdown.utilities > 0) {
      const parts = [];
      if (breakdown.rent > 0) parts.push(`Rent: ${formatAmount(breakdown.rent)}`);
      if (breakdown.water > 0) parts.push(`Water: ${formatAmount(breakdown.water)}`);
      if (breakdown.utilities > 0) parts.push(`Utils: ${formatAmount(breakdown.utilities)}`);
      if (breakdown.deposit > 0) parts.push(`Deposit: ${formatAmount(breakdown.deposit)}`);

      if (parts.length > 0) {
        message += `(Breakdown: ${parts.join(', ')}). `;
      }
    }

        const formatPhoneAsAccount = (phone) => {
      if (!phone) return 'Tenant Phone';
      let clean = phone.trim().replace(/\s+/g, '').replace(/\+/g, '');
      if (clean.startsWith('254')) {
        clean = '0' + clean.substring(3);
      }
      if (!clean.startsWith('0') && clean.length >= 9) {
        clean = '0' + clean;
      }
      return clean;
    };

    message += `Pay: Paybill ${paymentInfo.paybill}, Acc ${formatPhoneAsAccount(paymentInfo.accountNumber)}. Due soon.`;

    console.log('✅ Invoice SMS generated');
    return message;
  }

  /**
   * Alias for backward compatibility or thematic consistency
   */
  generateRentReminderSMS(tenantData, paymentInfo, hasOutstandingDeposit = false) {
    const debt = {
      debtCode: tenantData.unitName || tenantData.unitCode,
      storeOwner: { name: tenantData.name },
      remainingAmount: tenantData.totalAmount + (hasOutstandingDeposit ? tenantData.depositAmount : 0),
      breakdown: {
        rent: tenantData.rentAmount,
        utilities: tenantData.utilityFees,
        deposit: hasOutstandingDeposit ? tenantData.depositAmount : 0
      }
    };
    return this.generateInvoiceSMS(debt, paymentInfo);
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
   * @param {string} referenceNumber - Transaction reference
   * @param {Object} resultData - Resulting financial state {remainingAmount, status}
   * @returns {string} Payment confirmation message
   */
  generatePaymentConfirmationSMS(tenantData, amount, referenceNumber, resultData = {}) {
    console.log('💳 Generating payment confirmation SMS...');

    const formatAmount = (amount) => new Intl.NumberFormat('en-KE', {
      style: 'decimal',
      maximumFractionDigits: 0
    }).format(amount);

    const remaining = resultData.remainingAmount || 0;
    const status = resultData.status || 'Received';

    const message = `Payment Received! KSH ${formatAmount(amount)}. ` +
      `Ref: ${referenceNumber}. ` +
      `Unit: ${tenantData.unitCode}. ` +
      `Remaining: ${formatAmount(remaining)} (${status.toUpperCase()}). ` +
      `Thank you ${tenantData.name}!`;

    console.log('✅ Payment confirmation SMS generated');
    return message;
  }

  /**
   * Send SMS via TextSMS API
   * @param {string} to - Recipient's phone number
   * @param {string} message - SMS message content
   * @param {string} agencyId - Agency ID for quota and logging
   * @param {string} userId - User ID for logging
   * @param {string} debtId - Debt/Tenant ID for logging
   * @returns {Promise<Object>} SMS result with success status and messageId
   */
  async sendSMS(to, message, agencyId, userId, debtId) {
    console.log('📤 Attempting to send SMS...');
    console.log(`   - To: ${to}`);
    console.log(`   - Agency ID: ${agencyId}`);
    
    // 1. Calculate units and check quota
    const units = smsQuotaService.calculateUnits(message);
    const quotaCheck = await smsQuotaService.checkQuota(agencyId, units);

    if (!quotaCheck.canSend && !quotaCheck.isDefault) {
      console.error(`❌ SMS Quota Exceeded for ${agencyId}: ${quotaCheck.reason}`);
      return {
        success: false,
        error: quotaCheck.reason,
        quotaExceeded: true
      };
    }

    try {
      const formattedPhone = to.startsWith('+254') ? to.replace('+254', '254') :
        to.startsWith('0') ? '254' + to.substring(1) : to;
      const formattedMessage = encodeURIComponent(message.trim());

      if (message.length > 160) {
        console.warn(`⚠️ Message length exceeds 160 characters (${message.length}), it will be split into multiple SMS (${units} units)`);
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
        agencyId,
        userId,
        debtId,
        to,
        message,
        units,
        success: true,
        messageId: result.responses[0].messageid,
        timestamp: new Date()
      });

      // 2. Increment usage in quota service
      await smsQuotaService.incrementUsage(agencyId, units);

      return {
        success: true,
        messageId: result.responses[0].messageid,
        data: result.responses[0],
        units
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
    console.log(`   - Agency ID: ${smsData.agencyId}`);
    console.log(`   - User ID: ${smsData.userId}`);
    console.log(`   - Units: ${smsData.units}`);
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