// ============================================
// FILE: src/services/payment/kodipayPaybillService.js
// ============================================
const { db } = require('../../config/firebase');
const { doc, getDoc, collection, addDoc } = require('firebase/firestore');
const { findTenantForMpesa } = require('./mpesaPaymentHelper');
const smsProcessor = require('../../smsProcessor');
const { normalizePhoneNumber, getPaymentMonth } = smsProcessor;
const mpesaPayoutService = require('./mpesaPayoutService');

// Global KodiPay Master Credentials (from env)
const MASTER_CREDENTIALS = {
  consumerKey: process.env.KODIPAY_MASTER_CONSUMER_KEY || '',
  consumerSecret: process.env.KODIPAY_MASTER_CONSUMER_SECRET || '',
  initiatorName: process.env.KODIPAY_MASTER_INITIATOR_NAME || '',
  securityCredential: process.env.KODIPAY_MASTER_SECURITY_CREDENTIAL || '',
  shortCode: process.env.KODIPAY_MASTER_SHORTCODE || '4005473'
};

class KodipayPaybillService {
  /**
   * Processes the Daraja C2B Validation for Tier 3 (Golden Paybill).
   * Validates if the BillRefNumber (Account Number) corresponds to a valid agency prefix and tenant/property.
   */
  async processValidation(payload, agencyId, agencyConfig) {
    console.log(`🔍 [Tier 3] Processing Golden Paybill C2B Validation for agency: ${agencyId}`);

    try {
      const prefix = agencyConfig.agencyPrefix || '';
      const tenant = await findTenantForMpesa(agencyId, payload.MSISDN, payload.BillRefNumber, prefix);
      if (!tenant) {
        console.warn(`⚠️ [Tier 3 Validation] Tenant/Unit not found for ref: ${payload.BillRefNumber} and prefix: ${prefix}`);
        return {
          ResultCode: 1,
          ResultDesc: "Tenant or Unit not found"
        };
      }

      console.log(`✅ [Tier 3 Validation] Accept transaction for tenant: ${tenant.name}`);
      return {
        ResultCode: 0,
        ResultDesc: "Accepted"
      };
    } catch (error) {
      console.error('❌ [Tier 3 Validation] Error:', error.message);
      return {
        ResultCode: 1,
        ResultDesc: "Internal validation failure"
      };
    }
  }

  /**
   * Processes the Daraja C2B Confirmation for Tier 3 (Golden Paybill).
   * Performs ledger reconciliation, deduces KodiPay transaction fees, and triggers automated B2B/B2C payouts.
   */
  async processConfirmation(payload, agencyId, agencyConfig) {
    console.log(`✅ [Tier 3] Processing Golden Paybill C2B Confirmation for agency: ${agencyId}`);

    try {
      const prefix = agencyConfig.agencyPrefix || '';
      const tenant = await findTenantForMpesa(agencyId, payload.MSISDN, payload.BillRefNumber, prefix);
      if (!tenant) {
        console.error(`❌ [Tier 3 Confirmation] Tenant not found for payload BillRef: ${payload.BillRefNumber}`);
        return { success: false, error: 'Tenant not found during confirmation' };
      }

      // Call processRentalPayment to update Firestore ledgers, send SMS, etc.
      const result = await smsProcessor.processRentalPayment({
        transactionId: payload.TransID,
        amount: parseFloat(payload.TransAmount),
        accountNumber: tenant.phone, // Force match
        senderPhone: payload.MSISDN,
        senderPhoneNormalized: normalizePhoneNumber(payload.MSISDN),
        accountNumberNormalized: normalizePhoneNumber(tenant.phone),
        paymentMonth: getPaymentMonth(new Date()),
        date: new Date().toISOString(),
        senderName: `${payload.FirstName || ''} ${payload.MiddleName || ''} ${payload.LastName || ''}`.trim() || 'M-Pesa Tenant'
      });

      if (!result.success) {
        console.error('❌ Failed to process rental payment in Golden Paybill service:', result.error);
        return result;
      }

      // Trigger Automated Payouts using KodiPay master credentials
      const paymentAmount = parseFloat(payload.TransAmount);
      if (agencyConfig.payoutRouting === 'auto_split') {
        await this.triggerAutoSplitPayout(tenant, paymentAmount, agencyConfig);
      } else if (agencyConfig.payoutRouting === 'auto_full_to_agency') {
        await this.triggerAutoFullPayoutToAgency(tenant, paymentAmount, agencyConfig);
      }

      return {
        success: true,
        ResultCode: 0,
        ResultDesc: "Success"
      };
    } catch (error) {
      console.error('❌ [Tier 3 Confirmation] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Split-routing: Commission goes to agency (minus fees), net balance goes to landlord.
   */
  async triggerAutoSplitPayout(tenant, paymentAmount, agencyConfig) {
    const propertyRef = doc(db, 'properties', tenant.propertyId);
    const propertySnap = await getDoc(propertyRef);
    if (!propertySnap.exists()) return;
    const property = propertySnap.data();

    if (!property.ownerId) {
      console.log('⚠️ Property has no owner linked. Skipping auto-split.');
      return;
    }

    const landlordRef = doc(db, 'clients', property.ownerId);
    const landlordSnap = await getDoc(landlordRef);
    if (!landlordSnap.exists()) return;
    const landlord = landlordSnap.data();

    const commissionRate = landlord.commissionRate !== undefined ? parseFloat(landlord.commissionRate) : 10;
    const agencyCommission = parseFloat((paymentAmount * (commissionRate / 100)).toFixed(2));
    const landlordAmount = parseFloat((paymentAmount - agencyCommission).toFixed(2));

    console.log(`💸 [Golden Paybill] Auto-split payout: Gross=${paymentAmount}, Commission=${agencyCommission} (${commissionRate}%), Landlord Net=${landlordAmount}`);

    // NOTE: Safaricom B2B/B2C fees are deducted from the sender's (KodiPay paybill) float
    // automatically by Safaricom. Do NOT subtract them from payout amounts in code.

    // 1. Payout Landlord Net
    if (landlordAmount > 0) {
      const refCode = `KP-LND-${payloadRefId()}`;
      await this.recordPayoutInFirestore(
        tenant.agencyId,
        property.ownerId,
        landlord.name,
        landlord.email,
        landlordAmount,
        landlord.payoutMethod || 'mpesa_b2c',
        refCode,
        'Landlord net disbursal via Golden Paybill'
      );

      try {
        await this.executeRealPayout(landlordAmount, landlord.payoutMethod, landlord.payoutDetails || landlord.phone, refCode, MASTER_CREDENTIALS);
        console.log(`✅ [Golden Paybill] Landlord payout of KSh ${landlordAmount} triggered. Ref: ${refCode}`);
      } catch (err) {
        console.error('❌ Failed to execute Landlord payout:', err.message);
      }
    }

    // 2. Payout Agency Commission
    // Commission is paid out directly — no in-code fee deduction
    if (agencyCommission > 0) {
      const refCode = `KP-AGC-${payloadRefId()}`;
      const agencyPayoutNumber = agencyConfig.paymentMethods?.mpesaNumber || '';
      const type = agencyConfig.paymentMethods?.mpesaType;
      const agencyPayoutType = type === 'till' ? 'mpesa_b2b_till' : (type === 'paybill' ? 'mpesa_b2b_paybill' : 'mpesa_b2c');

      if (!agencyPayoutNumber) {
        console.warn(`⚠️ [Golden Paybill] Agency commission of KSh ${agencyCommission} NOT disbursed — no payout number configured for agency ${agencyConfig.agencyName}`);
        return;
      }

      await this.recordPayoutInFirestore(
        tenant.agencyId,
        'AGENCY_COMMISSION',
        agencyConfig.agencyName || 'Agency Commission',
        agencyConfig.customerServiceNumber || '',
        agencyCommission,
        agencyPayoutType,
        refCode,
        `Agency commission disbursal — ${commissionRate}% of KSh ${paymentAmount}`
      );

      try {
        await this.executeRealPayout(agencyCommission, agencyPayoutType, agencyPayoutNumber, refCode, MASTER_CREDENTIALS);
        console.log(`✅ [Golden Paybill] Agency commission of KSh ${agencyCommission} triggered via ${agencyPayoutType}. Ref: ${refCode}`);
      } catch (err) {
        console.error('❌ Failed to execute Agency commission payout:', err.message);
      }
    } else {
      console.warn(`⚠️ [Golden Paybill] Agency commission is KSh 0 — skipping commission payout.`);
    }
  }

  /**
   * Forward 100% of the rent directly to the agency's paybill (minus transaction cost).
   */
  async triggerAutoFullPayoutToAgency(tenant, paymentAmount, agencyConfig) {
    console.log(`💸 [Golden Paybill] Auto-forward 100% to agency: Gross=${paymentAmount}`);

    // Deduct single transfer cost
    const transactionCost = 7;
    const forwardAmount = Math.max(0, paymentAmount - transactionCost);

    if (forwardAmount > 0) {
      const refCode = `KP-FWD-${payloadRefId()}`;
      const agencyPayoutNumber = agencyConfig.paymentMethods?.mpesaNumber || '';
      const type = agencyConfig.paymentMethods?.mpesaType;
      const agencyPayoutType = type === 'till' ? 'mpesa_b2b_till' : (type === 'paybill' ? 'mpesa_b2b_paybill' : 'mpesa_b2c');

      await this.recordPayoutInFirestore(
        tenant.agencyId,
        'AGENCY_FORWARD',
        agencyConfig.agencyName || 'Agency Forward',
        agencyConfig.customerServiceNumber || '',
        forwardAmount,
        agencyPayoutType,
        refCode,
        '100% automated rent forward (less processing fee)'
      );

      try {
        await this.executeRealPayout(forwardAmount, agencyPayoutType, agencyPayoutNumber, refCode, MASTER_CREDENTIALS);
      } catch (err) {
        console.error('❌ Failed to execute Agency forward payout:', err.message);
      }
    }
  }

  async executeRealPayout(amount, method, targetNumber, refCode, credentials) {
    if (!credentials || !credentials.consumerKey) {
      console.warn('⚠️ Master API credentials missing, skipping real B2C/B2B execution for', refCode);
      return;
    }

    // Normalize method
    if (method === 'bank') {
      console.warn('⚠️ Bank payouts not yet implemented automatically. Skipping', refCode);
      return;
    }

    if (method === 'mpesa_b2b' || method === 'mpesa_b2b_paybill' || method === 'paybill') {
      await mpesaPayoutService.triggerB2B(credentials, amount, targetNumber, 'paybill', 'KodiPay Payout', refCode);
    } else if (method === 'mpesa_b2b_till' || method === 'till') {
      await mpesaPayoutService.triggerB2B(credentials, amount, targetNumber, 'till', 'KodiPay Payout', refCode);
    } else {
      // Default B2C
      await mpesaPayoutService.triggerB2C(credentials, amount, targetNumber, 'KodiPay Rent', refCode);
    }
  }

  async recordPayoutInFirestore(agencyId, clientId, clientName, emailOrPhone, amount, method, refCode, notes) {
    const payoutRef = collection(db, 'payouts');
    await addDoc(payoutRef, {
      agencyId,
      clientId,
      clientName,
      clientEmail: emailOrPhone.includes('@') ? emailOrPhone : '',
      clientPhone: !emailOrPhone.includes('@') ? emailOrPhone : '',
      amount: parseFloat(amount),
      payoutMonth: new Date().toISOString().substring(0, 7), // YYYY-MM
      paymentMethod: method,
      referenceNumber: refCode,
      notes,
      createdAt: new Date().toISOString()
    });
    console.log(`✅ [Golden Paybill] Disbursed KSh ${amount} to ${clientName} via ${method}. Ref: ${refCode}`);
  }
}

// Generate simple unique receipt ref
function payloadRefId() {
  return Math.random().toString(36).substring(2, 9).toUpperCase();
}

module.exports = new KodipayPaybillService();
