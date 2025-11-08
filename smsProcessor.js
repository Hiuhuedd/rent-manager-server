// ============================================
// ENHANCED RENT PAYMENT PROCESSING SYSTEM
// ============================================

const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
const SMSService = require('./smsService');

const db = getFirestoreApp();

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Normalize phone number to format without country code (0XXXXXXXXX)
 */
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

/**
 * Get the payment month in YYYY-MM format
 */
const getPaymentMonth = (date) => {
  const d = new Date(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
};

/**
 * Get the current month in YYYY-MM format
 */
const getCurrentMonth = () => {
  return getPaymentMonth(new Date());
};

/**
 * Check if a payment is for the current month
 */
const isCurrentMonthPayment = (paymentDate) => {
  return getPaymentMonth(paymentDate) === getCurrentMonth();
};

/**
 * Calculate rent components (rent, utilities, deposit)
 */
const calculateRentComponents = (unit, tenant, isNewTenant = false) => {
  const rent = parseFloat(unit.rentAmount) || 0;
  const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
  const water = parseFloat(unit.utilityFees?.waterBill) || 0;
  const deposit = parseFloat(unit.depositAmount) || 0;
  
  // Include deposit in expected payment only for new tenants in their first month
  const includeDeposit = isNewTenant && tenant.rentDeposit?.status === 'pending';
  const monthlyRent = rent + garbage + water;
  const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
  
  return {
    rent,
    garbage,
    water,
    deposit,
    monthlyRent,
    totalExpected,
    includeDeposit
  };
};

// ============================================
// PAYMENT TRACKING STRUCTURE
// ============================================

/**
 * Initialize or update monthly payment tracking
 */
const initializeMonthlyPaymentTracking = (tenant, unit) => {
  const currentMonth = getCurrentMonth();
  const components = calculateRentComponents(unit, tenant, false);
  
  return {
    month: currentMonth,
    expectedAmount: components.totalExpected,
    paidAmount: 0,
    remainingAmount: components.totalExpected,
    status: 'unpaid', // 'unpaid', 'partial', 'paid', 'overpaid'
    payments: [],
    breakdown: {
      rent: components.rent,
      utilities: components.garbage + components.water,
      deposit: 0
    }
  };
};

// ============================================
// MAIN PARSING FUNCTION
// ============================================

const parseMpesaWebhook = (webhookData) => {
  try {
    const { body } = webhookData;
    if (!body) throw new Error('No SMS body provided');

    const regex = /(\w+)\s+Confirmed\.\s+Ksh([\d,.]+)\.\d{2}\s+received\s+from\s+([^0-9]+?)\s+(\d{10,12})\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2}).*?Account\s+Number\s+([\w\d]+)/i;
    const match = body.match(regex);

    if (!match) {
      console.error('SMS body:', body);
      throw new Error('Invalid M-Pesa SMS format');
    }

    const [, transactionId, amount, senderName, senderPhone, date, accountNumber] = match;
    
    const [day, month, year] = date.split('/');
    const fullYear = parseInt(year) + 2000;
    const parsedDate = new Date(fullYear, parseInt(month) - 1, parseInt(day));

    const normalizedSenderPhone = normalizePhoneNumber(senderPhone);
    const normalizedAccountNumber = accountNumber;

    return {
      success: true,
      data: {
        transactionId: transactionId.trim(),
        date: parsedDate.toISOString(),
        paymentMonth: getPaymentMonth(parsedDate),
        amount: parseFloat(amount.replace(/,/g, '')),
        senderName: senderName.trim(),
        senderPhone: senderPhone.trim(),
        senderPhoneNormalized: normalizedSenderPhone,
        accountNumber: accountNumber.trim(),
        accountNumberNormalized: normalizedAccountNumber,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ============================================
// ENHANCED PAYMENT PROCESSING
// ============================================

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
      date
    } = paymentData;

    console.log('🔍 Processing payment for month:', paymentMonth);
    console.log('  - Amount: KSh', amount);
    console.log('  - Account:', accountNumber, '→', accountNumberNormalized);

    // ============================================
    // 1️⃣ FIND TENANT (Multiple Strategies)
    // ============================================
    
    let tenant = null;
    let matchStrategy = '';

    // Strategy 1: Search by normalized account number
    const tenantsByAccountQuery = query(
      collection(db, 'tenants'), 
      where('phone', '==', accountNumberNormalized)
    );
    const tenantsByAccountSnapshot = await getDocs(tenantsByAccountQuery);

    if (!tenantsByAccountSnapshot.empty) {
      tenant = { id: tenantsByAccountSnapshot.docs[0].id, ...tenantsByAccountSnapshot.docs[0].data() };
      matchStrategy = 'account number';
    } else {
      // Strategy 2: Search by sender phone
      const tenantsByPhoneQuery = query(
        collection(db, 'tenants'), 
        where('phone', '==', accountNumberNormalized)
      );
      const tenantsByPhoneSnapshot = await getDocs(tenantsByPhoneQuery);
      
      if (!tenantsByPhoneSnapshot.empty) {
        tenant = { id: tenantsByPhoneSnapshot.docs[0].id, ...tenantsByPhoneSnapshot.docs[0].data() };
        matchStrategy = 'sender phone';
      } else {
        // Strategy 3: Manual matching
        const allTenantsSnapshot = await getDocs(collection(db, 'tenants'));
        for (const doc of allTenantsSnapshot.docs) {
          const data = doc.data();
          const normalizedTenantPhone = normalizePhoneNumber(data.phone);
          
          if (normalizedTenantPhone === accountNumberNormalized || 
              normalizedTenantPhone === senderPhoneNormalized) {
            tenant = { id: doc.id, ...data };
            matchStrategy = 'manual matching';
            break;
          }
        }
      }
    }

    if (!tenant) {
      console.error('❌ No tenant found');
      return { 
        success: false, 
        error: `No tenant found for account ${accountNumber}` 
      };
    }

    console.log('✅ Tenant found:', tenant.name, '(', matchStrategy, ')');

    // ============================================
    // 2️⃣ GET UNIT DETAILS
    // ============================================
    
    const unitsQuery = query(
      collection(db, 'units'),
      where('unitId', '==', tenant.unitCode)
    );
    const unitsSnapshot = await getDocs(unitsQuery);
    
    if (unitsSnapshot.empty) {
      return { success: false, error: 'Unit not found' };
    }
    
    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc.data();

    // ============================================
    // 3️⃣ CALCULATE PAYMENT ALLOCATION
    // ============================================
    
    const currentMonth = getCurrentMonth();
    const isCurrentMonth = paymentMonth === currentMonth;
    
    // Get current monthly payment tracking
    let monthlyTracking = tenant.monthlyPaymentTracking || initializeMonthlyPaymentTracking(tenant, unit);
    
    // If payment is for a different month or new month started, reset tracking
    if (monthlyTracking.month !== paymentMonth) {
      monthlyTracking = initializeMonthlyPaymentTracking(tenant, unit);
      monthlyTracking.month = paymentMonth;
    }
    
    // Check if deposit is still pending
    const depositPending = tenant.rentDeposit?.status === 'pending';
    const depositAmount = depositPending ? (parseFloat(unit.depositAmount) || 0) : 0;
    
    // Calculate payment allocation
    let remainingPayment = amount;
    let allocatedToDeposit = 0;
    let allocatedToRent = 0;
    let allocatedToUtilities = 0;
    
    // Priority 1: Deposit (if pending)
    if (depositPending && depositAmount > 0) {
      allocatedToDeposit = Math.min(remainingPayment, depositAmount);
      remainingPayment -= allocatedToDeposit;
    }
    
    // Priority 2: Rent
    const rentAmount = parseFloat(unit.rentAmount) || 0;
    const rentPaid = monthlyTracking.breakdown.rent;
    const rentRemaining = Math.max(0, rentAmount - rentPaid);
    
    if (remainingPayment > 0 && rentRemaining > 0) {
      allocatedToRent = Math.min(remainingPayment, rentRemaining);
      remainingPayment -= allocatedToRent;
    }
    
    // Priority 3: Utilities
    const utilitiesAmount = (parseFloat(unit.utilityFees?.garbageFee) || 0) + 
                           (parseFloat(unit.utilityFees?.waterBill) || 0);
    const utilitiesPaid = monthlyTracking.breakdown.utilities;
    const utilitiesRemaining = Math.max(0, utilitiesAmount - utilitiesPaid);
    
    if (remainingPayment > 0 && utilitiesRemaining > 0) {
      allocatedToUtilities = Math.min(remainingPayment, utilitiesRemaining);
      remainingPayment -= allocatedToUtilities;
    }
    
    // Update monthly tracking
    monthlyTracking.paidAmount += amount;
    monthlyTracking.breakdown.rent += allocatedToRent;
    monthlyTracking.breakdown.utilities += allocatedToUtilities;
    monthlyTracking.breakdown.deposit += allocatedToDeposit;
    monthlyTracking.remainingAmount = Math.max(0, monthlyTracking.expectedAmount - monthlyTracking.paidAmount);
    
    // Update status
    if (monthlyTracking.paidAmount >= monthlyTracking.expectedAmount) {
      monthlyTracking.status = 'paid';
    } else if (monthlyTracking.paidAmount > 0) {
      monthlyTracking.status = 'partial';
    } else {
      monthlyTracking.status = 'unpaid';
    }
    
    // Add payment to tracking
    monthlyTracking.payments.push({
      transactionId,
      amount,
      date: date,
      timestamp: new Date().toISOString(),
      allocation: {
        deposit: allocatedToDeposit,
        rent: allocatedToRent,
        utilities: allocatedToUtilities
      }
    });

    // ============================================
    // 4️⃣ UPDATE FINANCIAL SUMMARY
    // ============================================
    
    const currentArrears = tenant.financialSummary?.arrears || tenant.arrears || 0;
    const newArrears = Math.max(0, currentArrears - amount);
    const totalPaid = (tenant.financialSummary?.totalPaid || 0) + amount;
    const balance = (tenant.financialSummary?.balance || 0) + amount;
    
    // Update deposit status if fully paid
    let updatedDepositStatus = tenant.rentDeposit?.status || 'not_required';
    if (allocatedToDeposit > 0 && allocatedToDeposit >= depositAmount) {
      updatedDepositStatus = 'paid';
    }

    // ============================================
    // 5️⃣ STORE PAYMENT RECORD
    // ============================================
    
    const paymentRef = doc(db, 'rental_payments', transactionId);
    await setDoc(paymentRef, {
      ...paymentData,
      tenantId: tenant.id,
      tenantName: tenant.name,
      unitCode: tenant.unitCode,
      propertyId: tenant.propertyId,
      propertyName: tenant.propertyDetails?.propertyName || '',
      timestamp: new Date().toISOString(),
      processed: true,
      matchStrategy,
      paymentMonth,
      allocation: {
        deposit: allocatedToDeposit,
        rent: allocatedToRent,
        utilities: allocatedToUtilities,
        excess: remainingPayment
      },
      monthlyStatus: monthlyTracking.status
    });

    // ============================================
    // 6️⃣ UPDATE TENANT DOCUMENT
    // ============================================
    
    const paymentLogEntry = {
      transactionId,
      amount,
      date: date,
      paymentMonth,
      timestamp: new Date().toISOString(),
      previousArrears: currentArrears,
      newArrears: newArrears,
      senderName: paymentData.senderName,
      allocation: {
        deposit: allocatedToDeposit,
        rent: allocatedToRent,
        utilities: allocatedToUtilities
      },
      monthlyStatus: monthlyTracking.status
    };

    await updateDoc(doc(db, 'tenants', tenant.id), {
      'financialSummary.arrears': newArrears,
      'financialSummary.totalPaid': totalPaid,
      'financialSummary.balance': balance,
      'financialSummary.lastUpdated': new Date().toISOString(),
      'paymentTimeline.lastPaymentDate': new Date().toISOString(),
      'rentDeposit.status': updatedDepositStatus,
      'rentDeposit.paidDate': allocatedToDeposit > 0 && updatedDepositStatus === 'paid' ? new Date().toISOString() : tenant.rentDeposit?.paidDate,
      monthlyPaymentTracking: monthlyTracking,
      updatedAt: new Date().toISOString(),
      paymentLogs: [
        ...(tenant.paymentLogs || []),
        paymentLogEntry
      ]
    });

    // ============================================
    // 7️⃣ UPDATE UNIT DOCUMENT
    // ============================================
    
    await updateDoc(doc(db, 'units', unitDoc.id), {
      lastPaymentDate: new Date().toISOString(),
      lastPaymentAmount: amount,
      lastPaymentTransactionId: transactionId,
      currentMonthPaid: isCurrentMonth ? (unit.currentMonthPaid || 0) + amount : unit.currentMonthPaid || 0,
      currentMonthStatus: isCurrentMonth ? monthlyTracking.status : unit.currentMonthStatus || 'unpaid',
      updatedAt: new Date().toISOString()
    });

    // ============================================
    // 8️⃣ SEND SMS CONFIRMATION
    // ============================================
    
    try {
      const debt = {
        debtCode: transactionId,
        storeOwner: { name: tenant.name },
        remainingAmount: newArrears,
      };
      const smsMessage = SMSService.generatePaymentConfirmationSMS(debt, amount);
      await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, transactionId);
      console.log(`📱 SMS confirmation sent to ${tenant.phone}`);
    } catch (smsError) {
      console.error('⚠️ Failed to send SMS:', smsError.message);
    }

    // ============================================
    // ✅ RETURN SUCCESS RESPONSE
    // ============================================
    
    console.log('✅ Payment processed successfully:');
    console.log(`   Transaction: ${transactionId}`);
    console.log(`   Tenant: ${tenant.name} (${tenant.phone})`);
    console.log(`   Month: ${paymentMonth}`);
    console.log(`   Amount: KSh ${amount}`);
    console.log(`   Allocation:`);
    console.log(`     - Deposit: KSh ${allocatedToDeposit}`);
    console.log(`     - Rent: KSh ${allocatedToRent}`);
    console.log(`     - Utilities: KSh ${allocatedToUtilities}`);
    console.log(`   Monthly Status: ${monthlyTracking.status}`);
    console.log(`   New Arrears: KSh ${newArrears}`);

    return {
      success: true,
      data: {
        transactionId,
        tenantId: tenant.id,
        tenantName: tenant.name,
        unitCode: tenant.unitCode,
        propertyId: tenant.propertyId,
        amount,
        paymentMonth,
        allocation: {
          deposit: allocatedToDeposit,
          rent: allocatedToRent,
          utilities: allocatedToUtilities,
          excess: remainingPayment
        },
        monthlyStatus: monthlyTracking.status,
        previousArrears: currentArrears,
        newArrears,
        depositStatus: updatedDepositStatus,
        matchStrategy,
      },
    };
  } catch (error) {
    console.error('❌ Error processing rental payment:', error);
    return { success: false, error: error.message };
  }
};

// ============================================
// MONTHLY RESET CRON JOB
// ============================================

/**
 * Reset monthly payment tracking for all tenants at the start of a new month
 * This should be run as a cron job on the 1st of every month
 */
const resetMonthlyPaymentTracking = async () => {
  try {
    console.log('🔄 Starting monthly payment tracking reset...');
    const currentMonth = getCurrentMonth();
    
    // Get all active tenants
    const tenantsQuery = query(
      collection(db, 'tenants'),
      where('tenantStatus', '==', 'active')
    );
    const tenantsSnapshot = await getDocs(tenantsQuery);
    
    let resetCount = 0;
    
    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      
      // Skip if already reset for current month
      if (tenant.monthlyPaymentTracking?.month === currentMonth) {
        continue;
      }
      
      // Get unit details
      const unitsQuery = query(
        collection(db, 'units'),
        where('unitId', '==', tenant.unitCode)
      );
      const unitsSnapshot = await getDocs(unitsQuery);
      
      if (unitsSnapshot.empty) continue;
      
      const unitDoc = unitsSnapshot.docs[0];
      const unit = unitDoc.data();
      
      // Initialize new month tracking
      const newMonthTracking = initializeMonthlyPaymentTracking(tenant, unit);
      
      // Update tenant document
      await updateDoc(doc(db, 'tenants', tenantDoc.id), {
        monthlyPaymentTracking: newMonthTracking,
        updatedAt: new Date().toISOString()
      });
      
      // Reset unit's current month tracking
      await updateDoc(doc(db, 'units', unitDoc.id), {
        currentMonthPaid: 0,
        currentMonthStatus: 'unpaid',
        updatedAt: new Date().toISOString()
      });
      
      resetCount++;
    }
    
    console.log(`✅ Monthly reset complete: ${resetCount} tenants updated`);
    return { success: true, resetCount };
    
  } catch (error) {
    console.error('❌ Error during monthly reset:', error);
    return { success: false, error: error.message };
  }
};

module.exports = { 
  parseMpesaWebhook, 
  processRentalPayment,
  resetMonthlyPaymentTracking,
  getCurrentMonth,
  getPaymentMonth
};