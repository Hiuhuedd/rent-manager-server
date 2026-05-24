// ============================================
// FILE: src/services/payment/mpesaPaymentHelper.js
// ============================================
const { db } = require('../../config/firebase');
const { collection, query, where, getDocs } = require('firebase/firestore');
const { normalizePhoneNumber } = require('../../smsProcessor');

/**
 * Resolves a tenant within a specific agency using their phone number or account number.
 * 
 * @param {string} agencyId 
 * @param {string} msisdn (Tenant Phone)
 * @param {string} billRefNumber (Account Number entered by tenant)
 * @param {string} [prefix] (Optional Tier 3 agency code prefix)
 */
async function findTenantForMpesa(agencyId, msisdn, billRefNumber, prefix = '') {
  const normalizedMSISDN = normalizePhoneNumber(msisdn);
  
  // Clean billRefNumber (e.g. remove agency prefix for Tier 3 if present)
  let cleanAccount = billRefNumber.trim();
  if (prefix && cleanAccount.toUpperCase().startsWith(prefix.toUpperCase())) {
    cleanAccount = cleanAccount.substring(prefix.length).replace(/^[\s\-]+/, '');
  }

  // 1. Try querying by phone directly using the sender's MSISDN
  const phoneQuery = query(
    collection(db, 'tenants'),
    where('agencyId', '==', agencyId),
    where('phone', '==', normalizedMSISDN)
  );
  const phoneSnap = await getDocs(phoneQuery);
  if (!phoneSnap.empty) {
    return { id: phoneSnap.docs[0].id, ...phoneSnap.docs[0].data() };
  }

  // 1.5 Try querying by phone using the BillRefNumber (Account Number as Tenant Phone)
  const normalizedBillRef = normalizePhoneNumber(cleanAccount);
  if (normalizedBillRef) {
    const billRefQuery = query(
      collection(db, 'tenants'),
      where('agencyId', '==', agencyId),
      where('phone', '==', normalizedBillRef)
    );
    const billRefSnap = await getDocs(billRefQuery);
    if (!billRefSnap.empty) {
      return { id: billRefSnap.docs[0].id, ...billRefSnap.docs[0].data() };
    }
  }

  // 2. Try querying by unitCode directly
  const unitQuery = query(
    collection(db, 'tenants'),
    where('agencyId', '==', agencyId),
    where('unitCode', '==', cleanAccount)
  );
  const unitSnap = await getDocs(unitQuery);
  if (!unitSnap.empty) {
    return { id: unitSnap.docs[0].id, ...unitSnap.docs[0].data() };
  }

  // 3. Fallback: manual scan of agency tenants to match unitCode with cleanAccount
  const agencyTenantsQuery = query(
    collection(db, 'tenants'),
    where('agencyId', '==', agencyId)
  );
  const snap = await getDocs(agencyTenantsQuery);
  for (const doc of snap.docs) {
    const tenant = doc.data();
    if (tenant.unitCode && cleanAccount.toUpperCase().includes(tenant.unitCode.toUpperCase())) {
      return { id: doc.id, ...tenant };
    }
  }

  return null;
}

module.exports = {
  findTenantForMpesa
};
