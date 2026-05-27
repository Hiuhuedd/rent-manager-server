// ============================================
// FILE: src/services/payment/dedicatedMpesaService.js
// ============================================
const { db } = require('../../config/firebase');
const { doc, getDoc, collection, addDoc } = require('firebase/firestore');
const { findTenantForMpesa } = require('./mpesaPaymentHelper');
const smsProcessor = require('../../smsProcessor');
const { normalizePhoneNumber, getPaymentMonth } = smsProcessor;
const mpesaPayoutService = require('./mpesaPayoutService');

// ⚡ TESTING MODE: Tier 2 payouts use KodiPay Master credentials directly.
// Swap these for per-agency credentials once agencies are onboarded.
const PAYOUT_CREDENTIALS = {
  consumerKey: process.env.KODIPAY_MASTER_CONSUMER_KEY || '',
  consumerSecret: process.env.KODIPAY_MASTER_CONSUMER_SECRET || '',
  initiatorName: process.env.KODIPAY_MASTER_INITIATOR_NAME || '',
  securityCredential: process.env.KODIPAY_MASTER_SECURITY_CREDENTIAL || '',
  shortCode: process.env.KODIPAY_MASTER_SHORTCODE || '4005473'
};

// KodiPay per-transaction fee deducted from agency commission only
const KODIPAY_TRANSACTION_FEE = 3;

class DedicatedMpesaService {
  /**
   * Processes the Daraja C2B Validation for Tier 2 (Dedicated M-Pesa).
   * Validates if the BillRefNumber (Account Number) corresponds to a valid tenant/property.
   */
  async processValidation(payload, agencyId) {
    console.log(`🔍 [Tier 2] Processing Daraja C2B Validation for agency: ${agencyId}`);

    try {
      const tenant = await findTenantForMpesa(agencyId, payload.MSISDN, payload.BillRefNumber);
      if (!tenant) {
        console.warn(`⚠️ [Tier 2 Validation] Tenant/Unit not found for ref: ${payload.BillRefNumber}`);
        return {
          ResultCode: 1,
          ResultDesc: "Tenant or Unit not found"
        };
      }

      console.log(`✅ [Tier 2 Validation] Accept transaction for tenant: ${tenant.name}`);
      return {
        ResultCode: 0,
        ResultDesc: "Accepted"
      };
    } catch (error) {
      console.error('❌ [Tier 2 Validation] Error during validation:', error.message);
      return {
        ResultCode: 1,
        ResultDesc: "Internal validation failure"
      };
    }
  }

  /**
   * Processes the Daraja C2B Confirmation for Tier 2 (Dedicated M-Pesa).
   * Performs ledger reconciliation, and triggers automated B2B/B2C payouts if configured.
   */
  async processConfirmation(payload, agencyId, agencyConfig) {
    console.log(`✅ [Tier 2] Processing Daraja C2B Confirmation for agency: ${agencyId}`);

    try {
      const tenant = await findTenantForMpesa(agencyId, payload.MSISDN, payload.BillRefNumber);
      if (!tenant) {
        console.error(`❌ [Tier 2 Confirmation] Tenant not found for payload BillRef: ${payload.BillRefNumber}`);
        return { success: false, error: 'Tenant not found during confirmation' };
      }

      // Update Firestore ledgers, send SMS, etc.
      const result = await smsProcessor.processRentalPayment({
        transactionId: payload.TransID,
        amount: parseFloat(payload.TransAmount),
        accountNumber: tenant.phone,
        senderPhone: payload.MSISDN,
        senderPhoneNormalized: normalizePhoneNumber(payload.MSISDN),
        accountNumberNormalized: normalizePhoneNumber(tenant.phone),
        paymentMonth: getPaymentMonth(new Date()),
        date: new Date().toISOString(),
        senderName: `${payload.FirstName || ''} ${payload.MiddleName || ''} ${payload.LastName || ''}`.trim() || 'M-Pesa Tenant'
      });

      if (!result.success) {
        console.error('❌ Failed to process rental payment in dedicated service:', result.error);
        return result;
      }

      const paymentAmount = parseFloat(payload.TransAmount);

      if (agencyConfig.payoutRouting === 'auto_split') {
        try {
          await this.triggerAutoSplitPayout(tenant, paymentAmount, agencyConfig);
        } catch (payoutErr) {
          console.error('❌ Auto-split payout failed:', payoutErr.message);
        }
      } else if (agencyConfig.payoutRouting === 'auto_full_to_agency') {
        try {
          await this.triggerAutoFullPayoutToAgency(tenant, paymentAmount, agencyConfig);
        } catch (payoutErr) {
          console.error('❌ Auto-full-forward payout failed:', payoutErr.message);
        }
      }

      return {
        success: true,
        ResultCode: 0,
        ResultDesc: "Success"
      };
    } catch (error) {
      console.error('❌ [Tier 2 Confirmation] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Split-routing: Commission (less KSh 3 fee) goes to agency, net balance goes to landlord.
   */
  async triggerAutoSplitPayout(tenant, paymentAmount, agencyConfig) {
    const propertyRef = doc(db, 'properties', tenant.propertyId);
    const propertySnap = await getDoc(propertyRef);
    if (!propertySnap.exists()) return;
    const property = propertySnap.data();

    if (!property.ownerId) {
      console.log('⚠️ [Tier 2] Property has no owner linked. Skipping auto-split.');
      return;
    }

    const landlordRef = doc(db, 'clients', property.ownerId);
    const landlordSnap = await getDoc(landlordRef);
    if (!landlordSnap.exists()) return;
    const landlord = landlordSnap.data();

    const commissionRate = landlord.commissionRate !== undefined ? parseFloat(landlord.commissionRate) : 8;
    const agencyCommission = parseFloat((paymentAmount * (commissionRate / 100)).toFixed(2));
    const landlordAmount = parseFloat((paymentAmount - agencyCommission).toFixed(2));
    const agencyNet = parseFloat(Math.max(0, agencyCommission - KODIPAY_TRANSACTION_FEE).toFixed(2));

    console.log(`💸 [Tier 2] Auto-split payout: Gross=${paymentAmount}, Commission=${agencyCommission} (${commissionRate}%), Fee=${KODIPAY_TRANSACTION_FEE}, Agency Net=${agencyNet}, Landlord Net=${landlordAmount}`);

    // 1. Payout Landlord Net (no fee deduction)
    if (landlordAmount > 0) {
      const refCode = `DED-LND-${payloadRefId()}`;
      await this.recordPayoutInFirestore(
        tenant.agencyId,
        property.ownerId,
        landlord.name,
        landlord.email,
        landlordAmount,
        landlord.payoutMethod || 'mpesa_b2c',
        refCode,
        'Landlord net disbursal via Dedicated M-Pesa (KodiPay credentials)'
      );

      try {
        await this.executeRealPayout(landlordAmount, landlord.payoutMethod, landlord.payoutDetails || landlord.phone, refCode, PAYOUT_CREDENTIALS);
        console.log(`✅ [Tier 2] Landlord payout of KSh ${landlordAmount} triggered. Ref: ${refCode}`);
      } catch (err) {
        console.error('❌ [Tier 2] Failed to execute Landlord payout:', err.message);
      }
    }

    // 2. Payout Agency Commission (less KSh 3 KodiPay transaction fee)
    if (agencyNet > 0) {
      const refCode = `DED-AGC-${payloadRefId()}`;
      const agencyPayoutNumber = agencyConfig.paymentMethods?.mpesaNumber || '';
      const type = agencyConfig.paymentMethods?.mpesaType;
      const agencyPayoutType = type === 'till' ? 'mpesa_b2b_till' : (type === 'paybill' ? 'mpesa_b2b_paybill' : 'mpesa_b2c');

      if (!agencyPayoutNumber) {
        console.warn(`⚠️ [Tier 2] Agency commission of KSh ${agencyNet} NOT disbursed — no payout number configured for agency ${agencyConfig.agencyName}`);
      } else {
        await this.recordPayoutInFirestore(
          tenant.agencyId,
          'AGENCY_COMMISSION',
          agencyConfig.agencyName || 'Agency Commission',
          agencyConfig.customerServiceNumber || '',
          agencyNet,
          agencyPayoutType,
          refCode,
          `Agency commission — ${commissionRate}% of KSh ${paymentAmount} less KSh ${KODIPAY_TRANSACTION_FEE} fee (KodiPay credentials)`
        );

        try {
          await this.executeRealPayout(agencyNet, agencyPayoutType, agencyPayoutNumber, refCode, PAYOUT_CREDENTIALS);
          console.log(`✅ [Tier 2] Agency commission of KSh ${agencyNet} triggered via ${agencyPayoutType}. Ref: ${refCode}`);
        } catch (err) {
          console.error('❌ [Tier 2] Failed to execute Agency commission payout:', err.message);
        }
      }
    } else {
      console.warn(`⚠️ [Tier 2] Agency commission (KSh ${agencyCommission}) is less than or equal to the KSh ${KODIPAY_TRANSACTION_FEE} fee — skipping commission payout.`);
    }
  }

  /**
   * Forward 100% of rent directly to the agency's till/paybill (less KSh 3 fee).
   */
  async triggerAutoFullPayoutToAgency(tenant, paymentAmount, agencyConfig) {
    const forwardAmount = parseFloat(Math.max(0, paymentAmount - KODIPAY_TRANSACTION_FEE).toFixed(2));

    console.log(`💸 [Tier 2] Auto-forward to agency: Gross=${paymentAmount}, Fee=${KODIPAY_TRANSACTION_FEE}, Forward=${forwardAmount}`);

    if (forwardAmount > 0) {
      const refCode = `DED-FWD-${payloadRefId()}`;
      const agencyPayoutNumber = agencyConfig.paymentMethods?.mpesaNumber || '';
      const type = agencyConfig.paymentMethods?.mpesaType;
      const agencyPayoutType = type === 'till' ? 'mpesa_b2b_till' : (type === 'paybill' ? 'mpesa_b2b_paybill' : 'mpesa_b2c');

      if (!agencyPayoutNumber) {
        console.warn(`⚠️ [Tier 2] Forward payout NOT disbursed — no payout number configured for agency ${agencyConfig.agencyName}`);
        return;
      }

      await this.recordPayoutInFirestore(
        tenant.agencyId,
        'AGENCY_FORWARD',
        agencyConfig.agencyName || 'Agency Forward',
        agencyConfig.customerServiceNumber || '',
        forwardAmount,
        agencyPayoutType,
        refCode,
        `100% rent forward less KSh ${KODIPAY_TRANSACTION_FEE} fee (KodiPay credentials)`
      );

      try {
        await this.executeRealPayout(forwardAmount, agencyPayoutType, agencyPayoutNumber, refCode, PAYOUT_CREDENTIALS);
        console.log(`✅ [Tier 2] Agency forward of KSh ${forwardAmount} triggered via ${agencyPayoutType}. Ref: ${refCode}`);
      } catch (err) {
        console.error('❌ [Tier 2] Failed to execute Agency forward payout:', err.message);
      }
    }
  }

  async executeRealPayout(amount, method, targetNumber, refCode, credentials) {
    if (!credentials || !credentials.consumerKey || !credentials.initiatorName) {
      console.warn('⚠️ [Tier 2] No valid payout credentials available. Skipping execution for', refCode);
      return;
    }

    if (method === 'bank') {
      console.warn('⚠️ [Tier 2] Bank payouts not implemented automatically. Skipping', refCode);
      return;
    }

    if (method === 'mpesa_b2b' || method === 'mpesa_b2b_paybill' || method === 'paybill') {
      await mpesaPayoutService.triggerB2B(credentials, amount, targetNumber, 'paybill', 'KodiPay Payout', refCode);
    } else if (method === 'mpesa_b2b_till' || method === 'till') {
      await mpesaPayoutService.triggerB2B(credentials, amount, targetNumber, 'till', 'KodiPay Payout', refCode);
    } else {
      await mpesaPayoutService.triggerB2C(credentials, amount, targetNumber, 'KodiPay Rent', refCode);
    }
  }

  async recordPayoutInFirestore(agencyId, clientId, clientName, emailOrPhone, amount, method, refCode, notes) {
    const payoutRef = collection(db, 'payouts');
    await addDoc(payoutRef, {
      agencyId,
      clientId,
      clientName,
      clientEmail: typeof emailOrPhone === 'string' && emailOrPhone.includes('@') ? emailOrPhone : '',
      clientPhone: typeof emailOrPhone === 'string' && !emailOrPhone.includes('@') ? emailOrPhone : '',
      amount: parseFloat(amount),
      payoutMonth: new Date().toISOString().substring(0, 7),
      paymentMethod: method,
      referenceNumber: refCode,
      notes: notes || 'Automated disbursal (Dedicated M-Pesa)',
      createdAt: new Date().toISOString()
    });
    console.log(`✅ [Tier 2] Recorded payout of KSh ${amount} to ${clientName} via ${method}. Ref: ${refCode}`);
  }
}

// Generate simple unique receipt ref
function payloadRefId() {
  return Math.random().toString(36).substring(2, 9).toUpperCase();
}

module.exports = new DedicatedMpesaService();
