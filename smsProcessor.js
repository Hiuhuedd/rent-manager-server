const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc, arrayUnion } = require('firebase/firestore');
const SMSService = require('./smsService');

const db = getFirestoreApp();

// Normalize phone number to format without country code (0XXXXXXXXX)
const normalizePhoneNumber = (phone) => {
  if (!phone) return '';

  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  cleaned = cleaned.replace(/^\+/, '');

  if (cleaned.startsWith('254')) {
    cleaned = '0' + cleaned.substring(3);
  }

  if (cleaned.length === 9 && /^[17]/.test(cleaned)) {
    cleaned = '0' + cleaned;
  }

  return cleaned;
};

// Get the payment month in YYYY-MM format
const getPaymentMonth = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

// Get the current month in YYYY-MM format
const getCurrentMonth = () => {
  return getPaymentMonth(new Date());
};

// Check if tenant moved in this month (is a new tenant)
const isNewTenant = (moveInDate) => {
  if (!moveInDate) return false;

  const moveIn = new Date(moveInDate);
  const now = new Date();

  return moveIn.getMonth() === now.getMonth() &&
    moveIn.getFullYear() === now.getFullYear();
};

const parseMpesaWebhook = (webhookData) => {
  try {
    const { body } = webhookData;
    if (!body) throw new Error('No SMS body provided');

    // Parse M-Pesa SMS format
    const regex = /^(\w+)\s+Confirmed\.?\s+on\s+\d{1,2}\/\d{1,2}\/\d{2,4}.*?Ksh([\d,.]+)\s+received\s+from\s+([^0-9]+?)\s+(\d{10,13}).*?Account\s+Number\s+(\d{9,12})/i;

    const match = body.match(regex);

    if (!match) {
      console.error('SMS did not match regex:', body);
      throw new Error('Invalid M-Pesa SMS format');
    }

    const [, transactionId, amountStr, senderName, senderPhone, accountNumber] = match;

    // Parse amount
    const amount = parseFloat(amountStr.replace(/,/g, ''));

    if (isNaN(amount)) {
      throw new Error('Failed to parse amount from SMS');
    }

    // Extract and parse date
    const dateMatch = body.match(/on\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
    if (!dateMatch) throw new Error('Date not found in SMS');

    const [, day, month, yearRaw] = dateMatch;
    const year = yearRaw.length === 2 ? 2000 + parseInt(yearRaw) : parseInt(yearRaw);
    const paymentDate = new Date(year, month - 1, day);

    return {
      success: true,
      data: {
        transactionId: transactionId.trim(),
        amount: amount,
        senderName: senderName.trim(),
        senderPhone: senderPhone.trim(),
        senderPhoneNormalized: normalizePhoneNumber(senderPhone),
        accountNumber: accountNumber.trim(),
        accountNumberNormalized: normalizePhoneNumber(accountNumber),
        date: paymentDate.toISOString(),
        paymentMonth: getPaymentMonth(paymentDate),
      }
    };
  } catch (error) {
    console.error('Parse failed:', error.message);
    return {
      success: false,
      error: error.message || 'Invalid M-Pesa SMS format'
    };
  }
};

const processRentalPayment = async (paymentData) => {
  try {
    const {
      transactionId,
      amount,
      accountNumber,
      senderPhone,
      senderPhoneNormalized,
      accountNumberNormalized,
      paymentMonth,
      date,
      senderName
    } = paymentData;

    const timestamp = new Date().toISOString();
    console.log('≡ƒöì Processing payment for month:', paymentMonth);
    console.log('  - Amount: KSh', amount);
    console.log('  - Account:', accountNumber, 'ΓåÆ', accountNumberNormalized);

    // ============================================
    // 1∩╕ÅΓâú FIND TENANT BY PHONE NUMBER
    // ============================================

    let tenant = null;
    let matchStrategy = '';

    // Try matching with account number first
    const tenantsByAccountQuery = query(
      collection(db, 'tenants'),
      where('phone', '==', accountNumberNormalized)
    );
    const tenantsByAccountSnapshot = await getDocs(tenantsByAccountQuery);

    if (!tenantsByAccountSnapshot.empty) {
      tenant = { id: tenantsByAccountSnapshot.docs[0].id, ...tenantsByAccountSnapshot.docs[0].data() };
      matchStrategy = 'account_number';
    } else {
      // Try matching with sender phone
      const tenantsByPhoneQuery = query(
        collection(db, 'tenants'),
        where('phone', '==', senderPhoneNormalized)
      );
      const tenantsByPhoneSnapshot = await getDocs(tenantsByPhoneQuery);

      if (!tenantsByPhoneSnapshot.empty) {
        tenant = { id: tenantsByPhoneSnapshot.docs[0].id, ...tenantsByPhoneSnapshot.docs[0].data() };
        matchStrategy = 'sender_phone';
      } else {
        // Fallback: manual scan
        const allTenantsSnapshot = await getDocs(collection(db, 'tenants'));
        for (const doc of allTenantsSnapshot.docs) {
          const data = doc.data();
          const normalizedTenantPhone = normalizePhoneNumber(data.phone);

          if (normalizedTenantPhone === accountNumberNormalized ||
            normalizedTenantPhone === senderPhoneNormalized) {
            tenant = { id: doc.id, ...data };
            matchStrategy = 'manual_scan';
            break;
          }
        }
      }
    }

    if (!tenant) {
      console.error('Γ¥î No tenant found');
      return {
        success: false,
        error: `No tenant found for account ${accountNumber}`
      };
    }

    console.log('Γ£à Tenant found:', tenant.name, '(', matchStrategy, ')');

    // ============================================
    // 2∩╕ÅΓâú GET UNIT DETAILS
    // ============================================

    const unitsQuery = query(
      collection(db, 'units'),
      where('unitId', '==', tenant.unitCode)
    );
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) {
      return { success: false, error: 'Unit not found for tenant' };
    }

    const unitDoc = unitsSnapshot.docs[0];
    const unit = { id: unitDoc.id, ...unitDoc.data() };

    // ============================================
    // 3∩╕ÅΓâú CALCULATE PAYMENT ALLOCATION
    // ============================================

    const rentAmount = parseFloat(unit.rentAmount) || 0;
    const garbageFee = parseFloat(unit.utilityFees?.garbageFee) || 0;

    // FETCH Month-Specific Water Bill for accuracy
    let waterBill = 0;
    const propertyRef = doc(db, 'properties', tenant.propertyId);
    const propertySnap = await getDoc(propertyRef);
    const propertyData = propertySnap.exists() ? propertySnap.data() : {};
    const isIndividualMeter = propertyData.waterMeterSettings?.meterType === 'individual';

    if (isIndividualMeter) {
      try {
        const waterBillRef = doc(db, 'water_bills', `${tenant.propertyId}_${paymentMonth}`);
        const waterBillSnap = await getDoc(waterBillRef);
        if (waterBillSnap.exists()) {
          const bills = waterBillSnap.data().bills || [];
          const unitBill = bills.find(b => b.unitId === tenant.unitCode);
          if (unitBill) {
            waterBill = parseFloat(unitBill.totalBill) || 0;
          }
        }
      } catch (err) {
        console.warn(`[SMS] Failed to fetch water bill for ${paymentMonth}:`, err.message);
      }
    } else {
      // Fallback to unit data if single meter or fetch failed
      waterBill = parseFloat(unit.utilityFees?.waterBill) || 0;
    }

    const utilitiesAmount = garbageFee + waterBill;
    const depositAmount = parseFloat(unit.depositAmount) || 0;

    // Check if deposit is required (Carry over existing logic)
    const isFirstMonth = isNewTenant(tenant.moveInDate);
    const depositPending = tenant.rentDeposit?.status === 'pending';
    const depositRequired = isFirstMonth && depositPending ? depositAmount : 0;

    console.log('≡ƒÆ░ Payment Allocation:');
    console.log(`   - New Tenant: ${isFirstMonth}`);
    console.log(`   - Deposit Required: KSh ${depositRequired}`);
    console.log(`   - Rent: KSh ${rentAmount}`);
    console.log(`   - Utilities: KSh ${utilitiesAmount}`);

    // Get previous payments for this month
    const monthPaymentsQuery = query(
      collection(db, 'financial_records'),
      where('tenantId', '==', tenant.id),
      where('paymentMonth', '==', paymentMonth)
    );
    const monthPaymentsSnapshot = await getDocs(monthPaymentsQuery);

    let depositAlreadyPaid = 0;
    let rentAlreadyPaid = 0;
    let utilitiesAlreadyPaid = 0;

    monthPaymentsSnapshot.docs.forEach(doc => {
      const payment = doc.data();
      depositAlreadyPaid += payment.allocation?.deposit || 0;
      rentAlreadyPaid += payment.allocation?.rent || 0;
      utilitiesAlreadyPaid += payment.allocation?.utilities || 0;
    });

    // Calculate remaining amounts
    const depositRemaining = Math.max(0, depositRequired - depositAlreadyPaid);
    const rentRemaining = Math.max(0, rentAmount - rentAlreadyPaid);
    const utilitiesRemaining = Math.max(0, utilitiesAmount - utilitiesAlreadyPaid);

    // Allocate payment
    let remainingPayment = amount;
    let allocatedToDeposit = 0;
    let allocatedToRent = 0;
    let allocatedToUtilities = 0;

    // Priority 1: Deposit
    if (depositRemaining > 0 && remainingPayment > 0) {
      allocatedToDeposit = Math.min(remainingPayment, depositRemaining);
      remainingPayment -= allocatedToDeposit;
    }

    // Priority 2: Rent
    if (rentRemaining > 0 && remainingPayment > 0) {
      allocatedToRent = Math.min(remainingPayment, rentRemaining);
      remainingPayment -= allocatedToRent;
    }

    // Priority 3: Utilities
    if (utilitiesRemaining > 0 && remainingPayment > 0) {
      allocatedToUtilities = Math.min(remainingPayment, utilitiesRemaining);
      remainingPayment -= allocatedToUtilities;
    }

    console.log(`   Γ£ô Deposit: KSh ${allocatedToDeposit}`);
    console.log(`   Γ£ô Rent: KSh ${allocatedToRent}`);
    console.log(`   Γ£ô Utilities: KSh ${allocatedToUtilities}`);
    console.log(`   Γ£ô Excess: KSh ${remainingPayment}`);

    // Calculate totals for this month after this payment
    const totalDepositPaid = depositAlreadyPaid + allocatedToDeposit;
    const totalRentPaid = rentAlreadyPaid + allocatedToRent;
    const totalUtilitiesPaid = utilitiesAlreadyPaid + allocatedToUtilities;
    const totalMonthlyPaid = totalDepositPaid + totalRentPaid + totalUtilitiesPaid;

    const expectedTotal = depositRequired + rentAmount + utilitiesAmount;
    const remainingTotal = Math.max(0, expectedTotal - totalMonthlyPaid);

    // Determine payment status for this month
    let monthlyStatus = 'unpaid';
    if (totalMonthlyPaid >= expectedTotal) {
      monthlyStatus = 'paid';
    } else if (totalMonthlyPaid > 0) {
      monthlyStatus = 'partial';
    }

    // ============================================
    // 4∩╕ÅΓâú CREATE FINANCIAL RECORD
    // ============================================

    const financialRecord = {
      // Identifiers
      transactionId,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantPhone: tenant.phone,
      unitId: unit.id,
      unitCode: tenant.unitCode,
      propertyId: tenant.propertyId,
      propertyName: tenant.propertyDetails?.propertyName || '',
      agencyId: tenant.agencyId || 'default',

      // Payment details
      amount,
      paymentDate: date,
      paymentMonth,
      timestamp,
      paymentMethod: paymentMethod || 'mpesa',
      source: 'M-Pesa SMS',

      // Sender details
      senderName,
      senderPhone,
      accountNumber,
      matchStrategy,

      // Allocation breakdown
      allocation: {
        deposit: allocatedToDeposit,
        rent: allocatedToRent,
        utilities: allocatedToUtilities,
        excess: remainingPayment
      },

      // Monthly tracking
      monthlyTracking: {
        expectedTotal,
        totalPaid: totalMonthlyPaid,
        remainingAmount: remainingTotal,
        status: monthlyStatus,
        breakdown: {
          deposit: {
            required: depositRequired,
            paid: totalDepositPaid,
            remaining: Math.max(0, depositRequired - totalDepositPaid)
          },
          rent: {
            required: rentAmount,
            paid: totalRentPaid,
            remaining: Math.max(0, rentAmount - totalRentPaid)
          },
          utilities: {
            required: utilitiesAmount,
            paid: totalUtilitiesPaid,
            remaining: Math.max(0, utilitiesAmount - totalUtilitiesPaid)
          }
        }
      },

      // Additional metadata
      isNewTenant: isFirstMonth,
      depositIncluded: depositRequired > 0,
      processed: true,
      createdAt: timestamp
    };

    // Use timestamp as document ID for uniqueness and chronological ordering
    const financialRecordRef = doc(db, 'financial_records', timestamp);
    await setDoc(financialRecordRef, financialRecord);

    console.log('Γ£à Financial record created:', timestamp);
    // ============================================
    const paymentEntry = {
      paymentId: timestamp,        // SAME ID used as doc ID in financial_records
      amount,
      paymentMonth,
      allocation: {
        deposit: allocatedToDeposit,
        rent: allocatedToRent,
        utilities: allocatedToUtilities
      },
      date: timestamp
    };

    // Append to payments[] array and update tracking fields
    await updateDoc(doc(db, 'tenants', tenant.id), {
      payments: arrayUnion(paymentEntry),
      monthlyPaymentTracking: financialRecord.monthlyTracking,
      financialSummary: {
        totalPaid: (tenant.financialSummary?.totalPaid || 0) + amount,
        arrears: (tenant.financialSummary?.arrears || 0) - (allocatedToDeposit + allocatedToRent + allocatedToUtilities),
        balance: (tenant.financialSummary?.balance || 0) + amount
      },
      arrears: Math.max(0, (tenant.arrears || 0) - (allocatedToDeposit + allocatedToRent + allocatedToUtilities)),
      updatedAt: timestamp
    });





    // ============================================
    // 6∩╕ÅΓâú SEND SMS CONFIRMATION
    // ============================================

    try {
      const smsMessage = SMSService.generatePaymentConfirmationSMS(
        { unitCode: tenant.unitCode, name: tenant.name },
        amount,
        transactionId,
        { remainingAmount: remainingTotal, status: monthlyStatus }
      );

      await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, transactionId);
      console.log(`≡ƒô▒ SMS sent to ${tenant.phone}`);
    } catch (smsError) {
      console.error('ΓÜá∩╕Å SMS failed:', smsError.message);
    }

    // ============================================
    // Γ£à RETURN SUCCESS
    // ============================================

    console.log('Γ£à Payment processed successfully');
    console.log(`   Transaction: ${transactionId}`);
    console.log(`   Tenant: ${tenant.name}`);
    console.log(`   Month: ${paymentMonth}`);
    console.log(`   Status: ${monthlyStatus}`);

    return {
      success: true,
      data: {
        transactionId,
        timestamp,
        tenantId: tenant.id,
        tenantName: tenant.name,
        unitCode: tenant.unitCode,
        amount,
        paymentMonth,
        allocation: {
          deposit: allocatedToDeposit,
          rent: allocatedToRent,
          utilities: allocatedToUtilities,
          excess: remainingPayment
        },
        monthlyStatus,
        remainingAmount: remainingTotal,
        matchStrategy
      }
    };
  } catch (error) {
    console.error('Γ¥î Error processing payment:', error);
    return { success: false, error: error.message };
  }
};

/**
 * Reset monthly payment tracking for all tenants
 * Called by cron job on the 1st of every month
 */
const resetMonthlyPaymentTracking = async () => {
  try {
    console.log('≡ƒöä Resetting monthly payment tracking for all tenants...');
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const currentMonth = getCurrentMonth();
    let resetCount = 0;

    const tenantService = require('./services/tenantService');

    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      const tracking = tenant.monthlyPaymentTracking;

      // Only reset if month has changed or tracking is missing
      if (!tracking || tracking.month !== currentMonth) {
        console.log(`   - Resetting tracking for: ${tenant.name}`);
        // We call getPaymentStatus which has the initialization & carry-over logic
        await tenantService.getPaymentStatus(tenantDoc.id);
        resetCount++;
      }
    }

    return { success: true, resetCount };
  } catch (error) {
    console.error('Γ¥î Reset failed:', error);
    return { success: false, error: error.message };
  }
};

module.exports = {
  parseMpesaWebhook,
  processRentalPayment,
  resetMonthlyPaymentTracking,
  getCurrentMonth,
  getPaymentMonth,
  normalizePhoneNumber
};