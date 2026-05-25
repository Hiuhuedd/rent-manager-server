// ============================================
// FILE: src/services/payment/dedicatedMpesaService.js
// ============================================
const { db } = require('../../config/firebase');
const { doc, getDoc, collection, addDoc } = require('firebase/firestore');
const { findTenantForMpesa } = require('./mpesaPaymentHelper');
const smsProcessor = require('../../smsProcessor');
const { normalizePhoneNumber, getPaymentMonth } = smsProcessor;
const mpesaPayoutService = require('./mpesaPayoutService');

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
        console.error('❌ Failed to process rental payment in dedicated service:', result.error);
        return result;
      }

      // Check if auto_split is enabled
      if (agencyConfig.payoutRouting === 'auto_split') {
        try {
          await this.triggerAutoSplitPayout(tenant, parseFloat(payload.TransAmount), agencyConfig);
        } catch (payoutErr) {
          console.error('❌ Auto-split payout failed:', payoutErr.message);
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
   * Splits money between Agency and Landlord, initiating automated B2C/B2B transfers.
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

    const commissionRate = landlord.commissionRate !== undefined ? parseFloat(landlord.commissionRate) : 8;
    const agencyCommission = paymentAmount * (commissionRate / 100);
    const landlordAmount = paymentAmount - agencyCommission;

    console.log(`💸 Auto-split payout: Gross=${paymentAmount}, Commission=${agencyCommission}, Landlord Net=${landlordAmount}`);

    if (landlordAmount <= 0) return;

    // Disburse Landlord Net portion using Agency's B2C/B2B credentials (stub API call for now)
    const refCode = `DED-${payloadRefId()}`;
    await this.recordPayoutInFirestore(tenant.agencyId, property.ownerId, landlord, landlordAmount, landlord.payoutMethod || 'mpesa_b2c', refCode);
    
    // Execute Real B2C/B2B
    try {
      await this.executeRealPayout(landlordAmount, landlord.payoutMethod || 'mpesa_b2c', landlord.payoutDetails || landlord.phone, refCode, agencyConfig.mpesaCredentials);
    } catch (err) {
      console.error('❌ [Dedicated M-Pesa] Failed to execute auto-split payout:', err.message);
    }
  }

  async executeRealPayout(amount, method, targetNumber, refCode, credentials) {
    if (!credentials || !credentials.consumerKey || !credentials.initiatorName) {
      console.warn('⚠️ [Dedicated M-Pesa] Agency B2C/B2B credentials missing, skipping real execution for', refCode);
      return;
    }
    
    if (method === 'bank') {
      console.warn('⚠️ [Dedicated M-Pesa] Bank payouts not implemented automatically. Skipping', refCode);
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

  async recordPayoutInFirestore(agencyId, clientId, landlord, amount, method, refCode) {
    const payoutRef = collection(db, 'payouts');
    await addDoc(payoutRef, {
      agencyId,
      clientId,
      clientName: landlord.name,
      clientEmail: landlord.email || '',
      amount: parseFloat(amount),
      payoutMonth: new Date().toISOString().substring(0, 7), // YYYY-MM
      paymentMethod: method,
      referenceNumber: refCode,
      notes: 'Automated auto-split disbursal (Dedicated M-Pesa)',
      createdAt: new Date().toISOString()
    });
    console.log(`✅ [Dedicated M-Pesa] Recorded auto-payout of KSh ${amount} to ${landlord.name} Ref: ${refCode}`);
  }
}

// Generate simple unique receipt ref
function payloadRefId() {
  return Math.random().toString(36).substring(2, 9).toUpperCase();
}

module.exports = new DedicatedMpesaService();
