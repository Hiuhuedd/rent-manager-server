// ============================================
// FILE: src/services/payment/kodipayPaybillService.js
// ============================================
const { db } = require('../../config/firebase');
const { doc, getDoc, collection, addDoc } = require('firebase/firestore');
const { findTenantForMpesa } = require('./mpesaPaymentHelper');
const smsProcessor = require('../../smsProcessor');
const { normalizePhoneNumber, getPaymentMonth } = smsProcessor;

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

    const commissionRate = landlord.commissionRate !== undefined ? parseFloat(landlord.commissionRate) : 8;
    const agencyCommission = paymentAmount * (commissionRate / 100);
    const landlordAmount = paymentAmount - agencyCommission;

    console.log(`💸 [Golden Paybill] Auto-split payout: Gross=${paymentAmount}, Commission=${agencyCommission}, Landlord Net=${landlordAmount}`);

    // Deduct transaction costs from Agency Commission
    // Assuming flat B2C transfer fee of KSh 22.30 per payout
    const transactionCost = 22.30;
    const adjustedAgencyCommission = Math.max(0, agencyCommission - (transactionCost * 2)); // 2 transactions: one to landlord, one to agency

    // 1. Payout Landlord Net
    if (landlordAmount > 0) {
      const refCode = `KP-LND-${payloadRefId()}`;
      await this.recordPayoutInFirestore(tenant.agencyId, property.ownerId, landlord.name, landlord.email, landlordAmount, landlord.payoutMethod || 'mpesa_b2c', refCode, 'Landlord net disbursal via Golden Paybill');
    }

    // 2. Payout Agency Adjusted Commission
    if (adjustedAgencyCommission > 0) {
      const refCode = `KP-AGC-${payloadRefId()}`;
      const agencyPayoutNumber = agencyConfig.paymentMethods?.mpesaNumber || '';
      const agencyPayoutType = agencyConfig.paymentMethods?.mpesaType === 'till' ? 'mpesa_b2b_till' : 'mpesa_b2b';
      
      await this.recordPayoutInFirestore(
        tenant.agencyId, 
        'AGENCY_COMMISSION', 
        agencyConfig.agencyName || 'Agency Commission', 
        agencyConfig.customerServiceNumber || '', 
        adjustedAgencyCommission, 
        agencyPayoutType, 
        refCode, 
        'Agency commission disbursal (less disbursal fees)'
      );
    }
  }

  /**
   * Forward 100% of the rent directly to the agency's paybill (minus transaction cost).
   */
  async triggerAutoFullPayoutToAgency(tenant, paymentAmount, agencyConfig) {
    console.log(`💸 [Golden Paybill] Auto-forward 100% to agency: Gross=${paymentAmount}`);
    
    // Deduct single transfer cost
    const transactionCost = 22.30;
    const forwardAmount = Math.max(0, paymentAmount - transactionCost);

    if (forwardAmount > 0) {
      const refCode = `KP-FWD-${payloadRefId()}`;
      const agencyPayoutNumber = agencyConfig.paymentMethods?.mpesaNumber || '';
      const agencyPayoutType = agencyConfig.paymentMethods?.mpesaType === 'till' ? 'mpesa_b2b_till' : 'mpesa_b2b';

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
