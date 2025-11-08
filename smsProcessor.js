// ============================================
// ENHANCED RENT PAYMENT PROCESSING SYSTEM (Account-Number Matching Only)
// ============================================

const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
const SMSService = require('./smsService');

const db = getFirestoreApp();

// ============================================
// UTILITY FUNCTIONS
// ============================================

/** Normalize phone number to 0XXXXXXXXX format */
const normalizePhoneNumber = (phone) => {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-\(\)]/g, '').replace(/^\+/, '');
  if (cleaned.startsWith('254')) cleaned = '0' + cleaned.substring(3);
  if (cleaned.length === 9 && /^[17]/.test(cleaned)) cleaned = '0' + cleaned;
  return cleaned;
};

/** Format date to YYYY-MM */
const getPaymentMonth = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const getCurrentMonth = () => getPaymentMonth(new Date());
const isCurrentMonthPayment = (paymentDate) => getPaymentMonth(paymentDate) === getCurrentMonth();

/** Compute rent components */
const calculateRentComponents = (unit, tenant, isNewTenant = false) => {
  const rent = parseFloat(unit.rentAmount) || 0;
  const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
  const water = parseFloat(unit.utilityFees?.waterBill) || 0;
  const deposit = parseFloat(unit.depositAmount) || 0;

  const includeDeposit = isNewTenant && tenant.rentDeposit?.status === 'pending';
  const monthlyRent = rent + garbage + water;
  const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);

  return { rent, garbage, water, deposit, monthlyRent, totalExpected, includeDeposit };
};

/** Initialize monthly tracking */
const initializeMonthlyPaymentTracking = (tenant, unit) => {
  const components = calculateRentComponents(unit, tenant, false);
  return {
    month: getCurrentMonth(),
    expectedAmount: components.totalExpected,
    paidAmount: 0,
    remainingAmount: components.totalExpected,
    status: 'unpaid',
    payments: [],
    breakdown: {
      rent: 0,
      utilities: 0,
      deposit: 0
    }
  };
};

// ============================================
// PARSE M-PESA WEBHOOK
// ============================================

const parseMpesaWebhook = (webhookData) => {
  try {
    const { body } = webhookData;
    if (!body) throw new Error('No SMS body provided');

    const regex =
      /(\w+)\s+Confirmed\.\s+Ksh([\d,.]+)\.\d{2}\s+received\s+from\s+([^0-9]+?)\s+(\d{10,12})\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2}).*?Account\s+Number\s+([\w\d]+)/i;

    const match = body.match(regex);
    if (!match) throw new Error('Invalid M-Pesa SMS format');

    const [, transactionId, amount, senderName, senderPhone, date, accountNumber] = match;
    const [day, month, year] = date.split('/');
    const fullYear = parseInt(year) + 2000;
    const parsedDate = new Date(fullYear, parseInt(month) - 1, parseInt(day));

    return {
      success: true,
      data: {
        transactionId: transactionId.trim(),
        amount: parseFloat(amount.replace(/,/g, '')),
        senderName: senderName.trim(),
        senderPhone: senderPhone.trim(),
        accountNumber: accountNumber.trim(),
        accountNumberNormalized: normalizePhoneNumber(accountNumber.trim()),
        date: parsedDate.toISOString(),
        paymentMonth: getPaymentMonth(parsedDate)
      }
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

// ============================================
// PROCESS RENTAL PAYMENT (ACCOUNT-ONLY MATCHING)
// ============================================

const processRentalPayment = async (paymentData) => {
  try {
    const {
      transactionId,
      amount,
      accountNumber,
      accountNumberNormalized,
      paymentMonth,
      date,
      senderName,
      senderPhone
    } = paymentData;

    console.log('\n💰 Processing Rent Payment');
    console.log(`🔹 Transaction ID: ${transactionId}`);
    console.log(`🔹 Amount: KSh ${amount}`);
    console.log(`🔹 Payment Month: ${paymentMonth}`);
    console.log(`🔹 Account (Tenant Phone): ${accountNumberNormalized}`);
    console.log(`ℹ️ Sender phone ignored — matched by account number only`);

    // ============================================
    // 1️⃣ FIND TENANT BY ACCOUNT NUMBER (TENANT PHONE)
    // ============================================
    const tenantsQuery = query(
      collection(db, 'tenants'),
      where('phone', 'in', [accountNumber, accountNumberNormalized])
    );
    const tenantsSnapshot = await getDocs(tenantsQuery);

    if (tenantsSnapshot.empty) {
      console.error(`❌ No tenant found for account number ${accountNumber}`);
      return { success: false, error: `No tenant found for account ${accountNumber}` };
    }

    const tenantDoc = tenantsSnapshot.docs[0];
    const tenant = { id: tenantDoc.id, ...tenantDoc.data() };
    console.log(`✅ Tenant matched: ${tenant.name} (${tenant.phone})`);

    // ============================================
    // 2️⃣ FETCH UNIT DETAILS
    // ============================================
    const unitQuery = query(collection(db, 'units'), where('unitId', '==', tenant.unitCode));
    const unitSnapshot = await getDocs(unitQuery);

    if (unitSnapshot.empty) {
      return { success: false, error: 'Unit not found for tenant' };
    }

    const unitDoc = unitSnapshot.docs[0];
    const unit = unitDoc.data();

    // ============================================
    // 3️⃣ ALLOCATE PAYMENT
    // ============================================
    const currentMonth = getCurrentMonth();
    let monthlyTracking = tenant.monthlyPaymentTracking || initializeMonthlyPaymentTracking(tenant, unit);
    if (monthlyTracking.month !== paymentMonth) {
      monthlyTracking = initializeMonthlyPaymentTracking(tenant, unit);
      monthlyTracking.month = paymentMonth;
    }

    let remainingPayment = amount;
    let allocated = { deposit: 0, rent: 0, utilities: 0 };

    const depositPending = tenant.rentDeposit?.status === 'pending';
    const depositAmount = depositPending ? parseFloat(unit.depositAmount) || 0 : 0;
    const rentAmount = parseFloat(unit.rentAmount) || 0;
    const utilitiesAmount = (parseFloat(unit.utilityFees?.garbageFee) || 0) + (parseFloat(unit.utilityFees?.waterBill) || 0);

    if (depositPending && depositAmount > 0) {
      allocated.deposit = Math.min(remainingPayment, depositAmount);
      remainingPayment -= allocated.deposit;
    }

    const rentRemaining = Math.max(0, rentAmount - monthlyTracking.breakdown.rent);
    if (remainingPayment > 0 && rentRemaining > 0) {
      allocated.rent = Math.min(remainingPayment, rentRemaining);
      remainingPayment -= allocated.rent;
    }

    const utilitiesRemaining = Math.max(0, utilitiesAmount - monthlyTracking.breakdown.utilities);
    if (remainingPayment > 0 && utilitiesRemaining > 0) {
      allocated.utilities = Math.min(remainingPayment, utilitiesRemaining);
      remainingPayment -= allocated.utilities;
    }

    monthlyTracking.paidAmount += amount;
    monthlyTracking.breakdown.rent += allocated.rent;
    monthlyTracking.breakdown.utilities += allocated.utilities;
    monthlyTracking.breakdown.deposit += allocated.deposit;
    monthlyTracking.remainingAmount = Math.max(0, monthlyTracking.expectedAmount - monthlyTracking.paidAmount);
    monthlyTracking.status =
      monthlyTracking.paidAmount >= monthlyTracking.expectedAmount
        ? 'paid'
        : monthlyTracking.paidAmount > 0
        ? 'partial'
        : 'unpaid';

    monthlyTracking.payments.push({
      transactionId,
      amount,
      date,
      allocation: allocated,
      timestamp: new Date().toISOString()
    });

    // ============================================
    // 4️⃣ UPDATE TENANT FINANCIAL SUMMARY
    // ============================================
    const arrears = tenant.financialSummary?.arrears || tenant.arrears || 0;
    const newArrears = Math.max(0, arrears - amount);
    const totalPaid = (tenant.financialSummary?.totalPaid || 0) + amount;

    let depositStatus = tenant.rentDeposit?.status || 'not_required';
    if (allocated.deposit > 0 && allocated.deposit >= depositAmount) depositStatus = 'paid';

    await updateDoc(doc(db, 'tenants', tenant.id), {
      'financialSummary.arrears': newArrears,
      'financialSummary.totalPaid': totalPaid,
      'financialSummary.lastUpdated': new Date().toISOString(),
      monthlyPaymentTracking: monthlyTracking,
      'rentDeposit.status': depositStatus,
      updatedAt: new Date().toISOString(),
      paymentLogs: [
        ...(tenant.paymentLogs || []),
        {
          transactionId,
          amount,
          date,
          paymentMonth,
          allocation: allocated,
          previousArrears: arrears,
          newArrears,
          monthlyStatus: monthlyTracking.status
        }
      ]
    });

    // ============================================
    // 5️⃣ STORE PAYMENT RECORD
    // ============================================
    await setDoc(doc(db, 'rental_payments', transactionId), {
      ...paymentData,
      tenantId: tenant.id,
      tenantName: tenant.name,
      unitCode: tenant.unitCode,
      propertyId: tenant.propertyId,
      processed: true,
      paymentMonth,
      allocation: allocated,
      monthlyStatus: monthlyTracking.status,
      timestamp: new Date().toISOString()
    });

    // ============================================
    // 6️⃣ UPDATE UNIT
    // ============================================
    await updateDoc(doc(db, 'units', unitDoc.id), {
      lastPaymentDate: new Date().toISOString(),
      lastPaymentAmount: amount,
      lastPaymentTransactionId: transactionId,
      currentMonthPaid: isCurrentMonthPayment(date)
        ? (unit.currentMonthPaid || 0) + amount
        : unit.currentMonthPaid || 0,
      currentMonthStatus: isCurrentMonthPayment(date)
        ? monthlyTracking.status
        : unit.currentMonthStatus || 'unpaid',
      updatedAt: new Date().toISOString()
    });

    // ============================================
    // 7️⃣ SEND SMS CONFIRMATION
    // ============================================
    try {
      const smsMessage = SMSService.generatePaymentConfirmationSMS(
        { storeOwner: { name: tenant.name }, remainingAmount: newArrears },
        amount
      );
      await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, transactionId);
      console.log(`📱 SMS sent to ${tenant.phone}`);
    } catch (smsError) {
      console.error('⚠️ SMS send failed:', smsError.message);
    }

    console.log(`✅ Payment processed for ${tenant.name}: KSh ${amount}, Month ${paymentMonth}`);
    return {
      success: true,
      data: {
        transactionId,
        tenantId: tenant.id,
        tenantName: tenant.name,
        paymentMonth,
        allocation: allocated,
        monthlyStatus: monthlyTracking.status,
        arrears: newArrears
      }
    };
  } catch (error) {
    console.error('❌ Payment processing error:', error.message);
    return { success: false, error: error.message };
  }
};

// ============================================
// MONTHLY RESET JOB
// ============================================

const resetMonthlyPaymentTracking = async () => {
  try {
    console.log('🔄 Starting monthly reset...');
    const currentMonth = getCurrentMonth();
    const tenantsQuery = query(collection(db, 'tenants'), where('tenantStatus', '==', 'active'));
    const tenantsSnapshot = await getDocs(tenantsQuery);
    let resetCount = 0;

    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      if (tenant.monthlyPaymentTracking?.month === currentMonth) continue;

      const unitQuery = query(collection(db, 'units'), where('unitId', '==', tenant.unitCode));
      const unitSnapshot = await getDocs(unitQuery);
      if (unitSnapshot.empty) continue;

      const unitDoc = unitSnapshot.docs[0];
      const unit = unitDoc.data();

      const newTracking = initializeMonthlyPaymentTracking(tenant, unit);
      await updateDoc(doc(db, 'tenants', tenantDoc.id), {
        monthlyPaymentTracking: newTracking,
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
    console.error('❌ Monthly reset error:', error.message);
    return { success: false, error: error.message };
  }
};

module.exports = { parseMpesaWebhook, processRentalPayment, resetMonthlyPaymentTracking, getCurrentMonth, getPaymentMonth };
