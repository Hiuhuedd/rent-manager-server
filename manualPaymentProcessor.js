// manualPaymentProcessor.js
// Handles admin-initiated manual payments, bypassing phone matching.
const { getFirestoreApp } = require('./firebase');
const {
  doc, getDoc, getDocs, setDoc, updateDoc, collection, query, where, arrayUnion
} = require('firebase/firestore');

const db = getFirestoreApp();
const smsService = require('./services/smsService');

const getPaymentMonth = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const processManualPayment = async ({ 
  tenantId, amount, paymentMethod = 'cash', paymentDate, paymentMonth, note = '',
  transactionCode, bankName, phoneNumber, receiptNumber, chequeNumber, chequeDate,
  agencyId
}) => {
  try {
    const timestamp = new Date().toISOString();
    const targetMonth = paymentMonth || getPaymentMonth(paymentDate || new Date());
    const dateIso = paymentDate ? new Date(paymentDate).toISOString() : timestamp;
    const transactionId = `MANUAL_${Date.now()}_${tenantId.slice(-6).toUpperCase()}`;

    // 1. Fetch tenant
    const tenantSnap = await getDoc(doc(db, 'tenants', tenantId));
    if (!tenantSnap.exists()) return { success: false, error: 'Tenant not found' };
    const tenant = { id: tenantSnap.id, ...tenantSnap.data() };

    // 2. Fetch unit
    const unitsSnap = await getDocs(query(
      collection(db, 'units'), 
      where('unitId', '==', tenant.unitCode),
      where('agencyId', '==', agencyId)
    ));
    if (unitsSnap.empty) return { success: false, error: 'Unit not found for tenant' };
    const unit = { id: unitsSnap.docs[0].id, ...unitsSnap.docs[0].data() };

    // 3. Fetch property
    const propertySnap = await getDoc(doc(db, 'properties', tenant.propertyId));
    const propertyData = propertySnap.exists() ? propertySnap.data() : {};
    const isIndividualMeter = propertyData.waterMeterSettings?.meterType === 'individual';

    const rentAmount = parseFloat(unit.rentAmount) || 0;
    const garbageFee = parseFloat(unit.utilityFees?.garbageFee) || 0;
    let waterBill = isIndividualMeter ? 0 : (parseFloat(unit.utilityFees?.waterBill) || 0);

    if (isIndividualMeter) {
      try {
        const wbSnap = await getDoc(doc(db, 'water_bills', `${tenant.propertyId}_${targetMonth}`));
        if (wbSnap.exists()) {
          const unitBill = (wbSnap.data().bills || []).find(b => b.unitId === tenant.unitCode);
          if (unitBill) waterBill = parseFloat(unitBill.totalBill) || 0;
        }
      } catch (_) {}
    }

    const utilitiesAmount = garbageFee + waterBill;
    const depositAmount = parseFloat(unit.depositAmount) || 0;

    // Check if deposit is required (New tenant logic)
    const moveInDate = tenant.moveInDate ? new Date(tenant.moveInDate) : null;
    const now = new Date();
    const isFirstMonth = moveInDate && moveInDate.getMonth() === now.getMonth() && moveInDate.getFullYear() === now.getFullYear();
    const depositPending = tenant.rentDeposit?.status === 'pending';
    const depositRequired = isFirstMonth && depositPending ? depositAmount : 0;

    // 4. Get previous payments this month
    const prevSnap = await getDocs(query(
      collection(db, 'financial_records'),
      where('tenantId', '==', tenant.id),
      where('paymentMonth', '==', targetMonth),
      where('agencyId', '==', agencyId)
    ));
    let rentAlreadyPaid = 0, utilitiesAlreadyPaid = 0, depositAlreadyPaid = 0;
    prevSnap.docs.forEach(d => {
      const p = d.data();
      rentAlreadyPaid += p.allocation?.rent || 0;
      utilitiesAlreadyPaid += p.allocation?.utilities || 0;
      depositAlreadyPaid += p.allocation?.deposit || 0;
    });

    // 5. Allocate: deposit -> rent → utilities → excess
    let remaining = amount;
    const depositRemaining = Math.max(0, depositRequired - depositAlreadyPaid);
    const allocatedToDeposit = Math.min(remaining, depositRemaining); remaining -= allocatedToDeposit;

    const rentRemaining = Math.max(0, rentAmount - rentAlreadyPaid);
    const allocatedToRent = Math.min(remaining, rentRemaining);       remaining -= allocatedToRent;

    const utilitiesRemaining = Math.max(0, utilitiesAmount - utilitiesAlreadyPaid);
    const allocatedToUtilities = Math.min(remaining, utilitiesRemaining); remaining -= allocatedToUtilities;
    
    const excess = remaining;

    const totalDepositPaid = depositAlreadyPaid + allocatedToDeposit;
    const totalRentPaid = rentAlreadyPaid + allocatedToRent;
    const totalUtilitiesPaid = utilitiesAlreadyPaid + allocatedToUtilities;
    const totalMonthlyPaid = totalDepositPaid + totalRentPaid + totalUtilitiesPaid;
    
    const expectedTotal = depositRequired + rentAmount + utilitiesAmount;
    const remainingTotal = Math.max(0, expectedTotal - totalMonthlyPaid);
    const monthlyStatus = totalMonthlyPaid >= expectedTotal ? 'paid' : totalMonthlyPaid > 0 ? 'partial' : 'unpaid';

    // 6. Write financial record
    const record = {
      transactionId, 
      tenantId: tenant.id, 
      tenantName: tenant.name,
      tenantPhone: tenant.phone,
      unitId: unit.id, 
      unitCode: tenant.unitCode,
      propertyId: tenant.propertyId,
      propertyName: tenant.propertyDetails?.propertyName || propertyData.propertyName || '',
      agencyId,
      amount, 
      paymentDate: dateIso, 
      paymentMonth: targetMonth, 
      timestamp,
      paymentMethod, 
      note, 
      transactionCode,
      bankName,
      phoneNumber,
      receiptNumber,
      chequeNumber,
      chequeDate,
      source: 'manual',
      allocation: { deposit: allocatedToDeposit, rent: allocatedToRent, utilities: allocatedToUtilities, excess },
      monthlyTracking: {
        expectedTotal, totalPaid: totalMonthlyPaid, remainingAmount: remainingTotal, status: monthlyStatus,
        breakdown: {
          deposit:   { required: depositRequired, paid: totalDepositPaid, remaining: Math.max(0, depositRequired - totalDepositPaid) },
          rent:      { required: rentAmount,      paid: totalRentPaid,      remaining: Math.max(0, rentAmount - totalRentPaid) },
          utilities: { required: utilitiesAmount, paid: totalUtilitiesPaid, remaining: Math.max(0, utilitiesAmount - totalUtilitiesPaid) }
        }
      },
      processed: true, 
      createdAt: timestamp
    };

    await setDoc(doc(db, 'financial_records', transactionId), record);

    // 7. Update tenant
    const updatedArrears = Math.max(0, (tenant.arrears || 0) - amount);

    await updateDoc(doc(db, 'tenants', tenant.id), {
      payments: arrayUnion({ paymentId: transactionId, amount, paymentMonth: targetMonth, date: timestamp }),
      monthlyPaymentTracking: record.monthlyTracking,
      financialSummary: {
        totalPaid: (tenant.financialSummary?.totalPaid || 0) + amount,
        arrears: updatedArrears,
        balance: (tenant.financialSummary?.balance || 0) + amount
      },
      arrears: updatedArrears,
      updatedAt: timestamp
    });

    console.log(`✅ Manual payment: ${transactionId} | ${tenant.name} | ${monthlyStatus}`);

    // 8. Send SMS Notification
    try {
      const confirmationMsg = smsService.generatePaymentConfirmationSMS(
        { name: tenant.name, unitCode: tenant.unitCode },
        amount,
        transactionCode || transactionId,
        { 
          remainingAmount: updatedArrears, 
          status: monthlyStatus === 'paid' ? 'Paid' : 'Balance' 
        }
      );

      if (tenant.phone) {
        console.log(`📱 Sending confirmation SMS to ${tenant.name} (${tenant.phone})...`);
        await smsService.sendSMS(tenant.phone, confirmationMsg, agencyId, 'system', tenant.id);
      } else {
        console.warn(`⚠️ No phone number for tenant ${tenant.name}, skipping SMS.`);
      }
    } catch (smsError) {
      console.error('⚠️ Failed to send payment confirmation SMS:', smsError.message);
    }

    return { success: true, data: { transactionId, tenantName: tenant.name, unitCode: tenant.unitCode, amount, paymentMonth: targetMonth, monthlyStatus, remainingAmount: remainingTotal } };
  } catch (err) {
    console.error('❌ Manual payment error:', err);
    return { success: false, error: err.message };
  }
};

module.exports = { processManualPayment };
