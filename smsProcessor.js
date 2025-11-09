const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
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

// Initialize monthly payment tracking for a tenant
const initializeMonthlyPaymentTracking = (tenant, unit) => {
  const currentMonth = getCurrentMonth();
  const rent = parseFloat(unit.rentAmount) || 0;
  const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
  const water = parseFloat(unit.utilityFees?.waterBill) || 0;
  const deposit = parseFloat(unit.depositAmount) || 0;
  
  // Check if this is the tenant's first month and deposit is still pending
  const isFirstMonth = isNewTenant(tenant.moveInDate);
  const depositPending = tenant.rentDeposit?.status === 'pending';
  const includeDeposit = isFirstMonth && depositPending && deposit > 0;
  
  const monthlyRent = rent + garbage + water;
  const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
  
  return {
    month: currentMonth,
    expectedAmount: totalExpected,
    paidAmount: 0,
    remainingAmount: totalExpected,
    status: 'unpaid',
    payments: [],
    breakdown: {
      deposit: 0,
      rent: 0,
      utilities: 0
    },
    includesDeposit: includeDeposit,
    depositRequired: includeDeposit ? deposit : 0
  };
};

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
    const normalizedAccountNumber = normalizePhoneNumber(accountNumber);

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
    // 1️⃣ FIND TENANT
    // ============================================
    
    let tenant = null;
    let matchStrategy = '';

    const tenantsByAccountQuery = query(
      collection(db, 'tenants'), 
      where('phone', '==', accountNumberNormalized)
    );
    const tenantsByAccountSnapshot = await getDocs(tenantsByAccountQuery);

    if (!tenantsByAccountSnapshot.empty) {
      tenant = { id: tenantsByAccountSnapshot.docs[0].id, ...tenantsByAccountSnapshot.docs[0].data() };
      matchStrategy = 'account number';
    } else {
      const tenantsByPhoneQuery = query(
        collection(db, 'tenants'), 
        where('phone', '==', senderPhoneNormalized)
      );
      const tenantsByPhoneSnapshot = await getDocs(tenantsByPhoneQuery);
      
      if (!tenantsByPhoneSnapshot.empty) {
        tenant = { id: tenantsByPhoneSnapshot.docs[0].id, ...tenantsByPhoneSnapshot.docs[0].data() };
        matchStrategy = 'sender phone';
      } else {
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
    // 3️⃣ INITIALIZE OR GET MONTHLY TRACKING
    // ============================================
    
    const currentMonth = getCurrentMonth();
    let monthlyTracking = tenant.monthlyPaymentTracking || null;
    
    // Initialize tracking if it doesn't exist or is for a different month
    if (!monthlyTracking || monthlyTracking.month !== paymentMonth) {
      monthlyTracking = initializeMonthlyPaymentTracking(tenant, unit);
      monthlyTracking.month = paymentMonth;
    }
    
    // ============================================
    // 4️⃣ SMART PAYMENT ALLOCATION
    // ============================================
    
    console.log('💰 Payment Allocation Logic:');
    console.log(`   - Is New Tenant: ${isNewTenant(tenant.moveInDate)}`);
    console.log(`   - Deposit Status: ${tenant.rentDeposit?.status}`);
    console.log(`   - Deposit Required This Month: ${monthlyTracking.depositRequired || 0}`);
    
    let remainingPayment = amount;
    let allocatedToDeposit = 0;
    let allocatedToRent = 0;
    let allocatedToUtilities = 0;
    
    // Get expected amounts
    const rentAmount = parseFloat(unit.rentAmount) || 0;
    const utilitiesAmount = (parseFloat(unit.utilityFees?.garbageFee) || 0) + 
                           (parseFloat(unit.utilityFees?.waterBill) || 0);
    const depositRequired = monthlyTracking.depositRequired || 0;
    
    // Get already paid amounts this month
    const depositAlreadyPaid = monthlyTracking.breakdown?.deposit || 0;
    const rentAlreadyPaid = monthlyTracking.breakdown?.rent || 0;
    const utilitiesAlreadyPaid = monthlyTracking.breakdown?.utilities || 0;
    
    // Calculate remaining amounts to pay
    const depositRemaining = Math.max(0, depositRequired - depositAlreadyPaid);
    const rentRemaining = Math.max(0, rentAmount - rentAlreadyPaid);
    const utilitiesRemaining = Math.max(0, utilitiesAmount - utilitiesAlreadyPaid);
    
    console.log('📊 Payment Breakdown:');
    console.log(`   - Total Payment: KSh ${amount}`);
    console.log(`   - Deposit Remaining: KSh ${depositRemaining}`);
    console.log(`   - Rent Remaining: KSh ${rentRemaining}`);
    console.log(`   - Utilities Remaining: KSh ${utilitiesRemaining}`);
    
    // PRIORITY 1: Deposit (for new tenants only)
    if (depositRemaining > 0 && remainingPayment > 0) {
      allocatedToDeposit = Math.min(remainingPayment, depositRemaining);
      remainingPayment -= allocatedToDeposit;
      console.log(`   ✓ Allocated to Deposit: KSh ${allocatedToDeposit} (Remaining: ${remainingPayment})`);
    }
    
    // PRIORITY 2: Rent
    if (rentRemaining > 0 && remainingPayment > 0) {
      allocatedToRent = Math.min(remainingPayment, rentRemaining);
      remainingPayment -= allocatedToRent;
      console.log(`   ✓ Allocated to Rent: KSh ${allocatedToRent} (Remaining: ${remainingPayment})`);
    }
    
    // PRIORITY 3: Utilities
    if (utilitiesRemaining > 0 && remainingPayment > 0) {
      allocatedToUtilities = Math.min(remainingPayment, utilitiesRemaining);
      remainingPayment -= allocatedToUtilities;
      console.log(`   ✓ Allocated to Utilities: KSh ${allocatedToUtilities} (Remaining: ${remainingPayment})`);
    }
    
    // Any excess remains unallocated (could be applied to future months or arrears)
    if (remainingPayment > 0) {
      console.log(`   ℹ️ Excess Payment: KSh ${remainingPayment} (Will reduce arrears)`);
    }
    
    // ============================================
    // 5️⃣ UPDATE MONTHLY TRACKING
    // ============================================
    
    monthlyTracking.paidAmount += amount;
    monthlyTracking.breakdown.deposit += allocatedToDeposit;
    monthlyTracking.breakdown.rent += allocatedToRent;
    monthlyTracking.breakdown.utilities += allocatedToUtilities;
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
    // 6️⃣ UPDATE FINANCIAL SUMMARY & ARREARS
    // ============================================
    
    const currentArrears = tenant.financialSummary?.arrears || tenant.arrears || 0;
    const newArrears = Math.max(0, currentArrears - amount);
    const totalPaid = (tenant.financialSummary?.totalPaid || 0) + amount;
    const balance = (tenant.financialSummary?.balance || 0) + amount;
    
    // Update deposit status if fully paid
    let updatedDepositStatus = tenant.rentDeposit?.status || 'not_required';
    let depositPaidDate = tenant.rentDeposit?.paidDate || null;
    
    if (depositRequired > 0 && (depositAlreadyPaid + allocatedToDeposit) >= depositRequired) {
      updatedDepositStatus = 'paid';
      depositPaidDate = new Date().toISOString();
      console.log('✅ Deposit fully paid!');
    }

    // ============================================
    // 7️⃣ STORE PAYMENT RECORD
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
      monthlyStatus: monthlyTracking.status,
      isNewTenant: isNewTenant(tenant.moveInDate),
      depositIncluded: depositRequired > 0
    });

    // ============================================
    // 8️⃣ UPDATE TENANT DOCUMENT
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
      'rentDeposit.paidDate': depositPaidDate,
      monthlyPaymentTracking: monthlyTracking,
      updatedAt: new Date().toISOString(),
      paymentLogs: [
        ...(tenant.paymentLogs || []),
        paymentLogEntry
      ]
    });

    // ============================================
    // 9️⃣ UPDATE UNIT DOCUMENT
    // ============================================
    
    const isCurrentMonth = paymentMonth === currentMonth;
    await updateDoc(doc(db, 'units', unitDoc.id), {
      lastPaymentDate: new Date().toISOString(),
      lastPaymentAmount: amount,
      lastPaymentTransactionId: transactionId,
      currentMonthPaid: isCurrentMonth ? (unit.currentMonthPaid || 0) + amount : unit.currentMonthPaid || 0,
      currentMonthStatus: isCurrentMonth ? monthlyTracking.status : unit.currentMonthStatus || 'unpaid',
      updatedAt: new Date().toISOString()
    });

    // ============================================
    // 🔟 SEND SMS CONFIRMATION
    // ============================================
    
    try {
      // Create detailed SMS message
      const smsBreakdown = [];
      if (allocatedToDeposit > 0) {
        smsBreakdown.push(`Deposit: KSh ${allocatedToDeposit.toLocaleString()}`);
      }
      if (allocatedToRent > 0) {
        smsBreakdown.push(`Rent: KSh ${allocatedToRent.toLocaleString()}`);
      }
      if (allocatedToUtilities > 0) {
        smsBreakdown.push(`Utilities: KSh ${allocatedToUtilities.toLocaleString()}`);
      }
      
      const smsMessage = `Payment received! KSh ${amount.toLocaleString()} allocated:\n${smsBreakdown.join('\n')}\n\nRemaining: KSh ${monthlyTracking.remainingAmount.toLocaleString()}\nStatus: ${monthlyTracking.status.toUpperCase()}\n\nThank you, ${tenant.name}!`;
      
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
    console.log(`   Deposit Status: ${updatedDepositStatus}`);
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

// Monthly reset function
const resetMonthlyPaymentTracking = async () => {
  try {
    console.log('🔄 Starting monthly payment tracking reset...');
    const currentMonth = getCurrentMonth();
    
    const tenantsQuery = query(
      collection(db, 'tenants'),
      where('tenantStatus', '==', 'active')
    );
    const tenantsSnapshot = await getDocs(tenantsQuery);
    
    let resetCount = 0;
    
    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      
      if (tenant.monthlyPaymentTracking?.month === currentMonth) {
        continue;
      }
      
      const unitsQuery = query(
        collection(db, 'units'),
        where('unitId', '==', tenant.unitCode)
      );
      const unitsSnapshot = await getDocs(unitsQuery);
      
      if (unitsSnapshot.empty) continue;
      
      const unitDoc = unitsSnapshot.docs[0];
      const unit = unitDoc.data();
      
      const newMonthTracking = initializeMonthlyPaymentTracking(tenant, unit);
      
      await updateDoc(doc(db, 'tenants', tenantDoc.id), {
        monthlyPaymentTracking: newMonthTracking,
        updatedAt: new Date().toISOString()
      });
      
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