
// ============================================
// FILE: src/services/tenantService.js
// ============================================
const { db } = require('../config/firebase');
const {
  collection, getDocs, getDoc, doc, query, where,
  addDoc, updateDoc, deleteDoc, setDoc
} = require('firebase/firestore');
const { getCurrentMonth, isMovedInThisMonth } = require('../utils/dateHelper');
const { PAYMENT_STATUS, TENANT_STATUS, DEPOSIT_STATUS } = require('../config/constants');
const smsService = require('../smsService');

class TenantService {
  async getAllTenants() {
    const currentMonth = getCurrentMonth();

    // Fetch tenants and financial records in parallel
    const [tenantsSnapshot, paymentsSnapshot] = await Promise.all([
      getDocs(collection(db, 'tenants')),
      getDocs(query(
        collection(db, 'financial_records'),
        where('paymentMonth', '==', currentMonth)
      ))
    ]);

    // Aggregate payments by tenant
    const paymentsByTenant = {};
    paymentsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      if (data.tenantId) {
        paymentsByTenant[data.tenantId] = (paymentsByTenant[data.tenantId] || 0) + (data.amount || 0);
      }
    });

    return tenantsSnapshot.docs.map(doc => {
      const data = doc.data();
      const paidThisMonth = paymentsByTenant[doc.id] || 0;

      // Use the arrears directly from the database as it is now updated in real-time by the SMS processor.
      // Manually subtracting paidThisMonth here causes double-discounting.
      const effectiveArrears = (data.financialSummary?.arrears || data.arrears || 0);

      return {
        id: doc.id,
        ...data,
        arrears: effectiveArrears, // Override arrears with calculated value
        originalArrears: data.arrears, // Keep original for reference if needed
        paidThisMonth,
        rentDeposit: data.rentDeposit || {
          amount: 0,
          status: DEPOSIT_STATUS.NOT_REQUIRED,
          paidDate: null,
          refundStatus: 'not_applicable'
        },
        utilityFees: data.utilityFees || {
          garbageFee: 0,
          waterBill: 0,
          electricity: 0,
          other: 0
        },
        financialSummary: data.financialSummary || {
          totalPaid: 0,
          arrears: 0,
          balance: 0
        },
        monthlyPaymentTracking: data.monthlyPaymentTracking || null
      };
    });
  }

  async getTenantById(id) {
    const status = await this.getPaymentStatus(id);

    if (!status) {
      return null;
    }

    const tenantRef = doc(db, 'tenants', id);
    const tenantSnap = await getDoc(tenantRef);
    const tenantData = tenantSnap.data();

    return {
      id: tenantSnap.id,
      ...tenantData,
      // Ensure we return the most up-to-date values calculated by getPaymentStatus
      monthlyPaymentTracking: tenantData.monthlyPaymentTracking,
      financialSummary: tenantData.financialSummary
    };
  }

  async getPaymentStatus(tenantId) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);

    if (!tenantSnap.exists()) {
      return null;
    }

    const tenant = tenantSnap.data();
    let monthlyTracking = tenant.monthlyPaymentTracking || null;
    const currentMonth = getCurrentMonth();

    // Initialize monthly tracking if needed
    if (!monthlyTracking || monthlyTracking.month !== currentMonth) {
      const unitsQuery = query(collection(db, 'units'), where('unitId', '==', tenant.unitCode));
      const unitsSnapshot = await getDocs(unitsQuery);

      if (!unitsSnapshot.empty) {
        const unit = unitsSnapshot.docs[0].data();

        // Get property to check water meter type
        const propertyRef = doc(db, 'properties', unit.propertyId);
        const propertySnap = await getDoc(propertyRef);
        const propertyData = propertySnap.exists() ? propertySnap.data() : {};
        const waterMeterType = propertyData.waterMeterSettings?.meterType || 'single';

        const rent = parseFloat(unit.rentAmount) || 0;
        const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
        let water = parseFloat(unit.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unit.depositAmount) || 0;

        // For properties with individual meters, fetch water bill from water_bills collection
        if (waterMeterType === 'individual') {
          try {
            const waterBillRef = doc(db, 'water_bills', `${unit.propertyId}_${currentMonth}`);
            const waterBillSnap = await getDoc(waterBillRef);

            if (waterBillSnap.exists()) {
              const waterBillData = waterBillSnap.data();
              const unitBill = waterBillData.bills?.find(b => b.unitId === unit.unitId);
              if (unitBill) {
                water = parseFloat(unitBill.totalBill) || 0;
              }
            }
          } catch (waterBillError) {
            console.warn(`⚠️ Failed to fetch water bill for unit ${unit.unitId}:`, waterBillError.message);
          }
        }

        const isNewTenant = isMovedInThisMonth(tenant.moveInDate);
        const depositPending = tenant.rentDeposit?.status === DEPOSIT_STATUS.PENDING;
        const includeDeposit = isNewTenant && depositPending && deposit > 0;

        const monthlyRent = rent + garbage + water;
        const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);

        // --- BALANCE CARRY-OVER LOGIC ---
        const existingBalance = tenant.financialSummary?.balance || 0;
        const carryOver = Math.max(0, Math.min(existingBalance, totalExpected));

        // Allocate carry-over (Priority: Deposit -> Rent -> Utilities)
        let remCarry = carryOver;
        let allocatedDeposit = 0;
        let allocatedRent = 0;
        let allocatedUtilities = 0;

        if (includeDeposit && remCarry > 0) {
          allocatedDeposit = Math.min(remCarry, deposit);
          remCarry -= allocatedDeposit;
        }
        if (remCarry > 0) {
          allocatedRent = Math.min(remCarry, rent);
          remCarry -= allocatedRent;
        }
        if (remCarry > 0) {
          allocatedUtilities = Math.min(remCarry, garbage + water);
          remCarry -= allocatedUtilities;
        }

        const remainingAmount = totalExpected - carryOver;
        let status = PAYMENT_STATUS.UNPAID;
        if (remainingAmount <= 0) status = PAYMENT_STATUS.PAID;
        else if (carryOver > 0) status = PAYMENT_STATUS.PARTIAL;

        monthlyTracking = {
          month: currentMonth,
          expectedAmount: totalExpected,
          paidAmount: carryOver,
          remainingAmount: remainingAmount,
          status: status,
          payments: [],
          breakdown: {
            deposit: allocatedDeposit,
            rent: allocatedRent,
            utilities: allocatedUtilities
          },
          includesDeposit: includeDeposit,
          depositRequired: includeDeposit ? deposit : 0
        };

        // Update Global Financial Stats
        // New Arrears = (Old Arrears + New Charge) - CarryOver
        const newGlobalArrears = Math.max(0, (tenant.financialSummary?.arrears || tenant.arrears || 0) + totalExpected - carryOver);
        const newGlobalBalance = existingBalance - carryOver - remainingAmount;
        // Note: balance = totalPaid - totalExpected. 
        // When new month starts, totalExpected increases, so balance decreases by totalExpected.
        // We already have existingBalance. New debt is totalExpected.
        // So global balance simply becomes existingBalance - totalExpected.

        await updateDoc(tenantRef, {
          monthlyPaymentTracking: monthlyTracking,
          financialSummary: {
            totalPaid: tenant.financialSummary?.totalPaid || 0,
            arrears: newGlobalArrears,
            balance: existingBalance - totalExpected
          },
          arrears: newGlobalArrears,
          updatedAt: new Date().toISOString()
        });
      }
    }

    monthlyTracking = monthlyTracking || {
      month: currentMonth,
      expectedAmount: 0,
      paidAmount: 0,
      remainingAmount: 0,
      status: PAYMENT_STATUS.UNPAID,
      payments: [],
      breakdown: { deposit: 0, rent: 0, utilities: 0 }
    };

    return {
      tenantId,
      tenantName: tenant.name,
      unitCode: tenant.unitCode,
      currentMonth: monthlyTracking.month || currentMonth,
      paymentStatus: monthlyTracking.status || PAYMENT_STATUS.UNPAID,
      expected: monthlyTracking.expectedAmount || 0,
      paid: monthlyTracking.paidAmount || 0,
      remaining: monthlyTracking.remainingAmount || 0,
      breakdown: monthlyTracking.breakdown || { deposit: 0, rent: 0, utilities: 0 },
      payments: monthlyTracking.payments || [],
      financialSummary: tenant.financialSummary || {
        totalPaid: 0,
        arrears: 0,
        balance: 0
      },
      depositStatus: tenant.rentDeposit?.status || DEPOSIT_STATUS.NOT_REQUIRED
    };
  }

  async createTenant(tenantData) {
    const start = Date.now();
    console.log('📥 Creating tenant:', tenantData.name);

    const { id, name, unitCode, phone } = tenantData;

    // Verify unit exists
    const unitsQuery = query(collection(db, 'units'), where('unitId', '==', unitCode));
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) {
      throw new Error(`Unit ${unitCode} not found`);
    }

    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc.data();
    const propertyDoc = await getDoc(doc(db, 'properties', unit.propertyId));

    const now = new Date().toISOString();
    const depositAmount = unit.depositAmount || 0;

    const completeTenantData = {
      name: name.trim(),
      unitCode,
      phone: phone.trim(),
      propertyId: unit.propertyId,

      // Property details, stripped of rent/deposit amounts
      propertyDetails: tenantData.propertyDetails || {
        propertyId: unit.propertyId,
        propertyName: propertyDoc.exists() ? propertyDoc.data().propertyName : 'Unknown',
        unitCategory: unit.category || 'Unknown',
      },

      // Payments array to track transaction IDs only
      payments: tenantData.payments || [],

      // Basic tenant info
      tenantStatus: tenantData.tenantStatus || 'active',
      moveInDate: tenantData.moveInDate || now,
      moveOutDate: tenantData.moveOutDate || null,
      createdAt: id ? undefined : now,
      updatedAt: now,

      contactInfo: tenantData.contactInfo || {
        email: null,
        alternatePhone: null,
        emergencyContact: {
          name: null,
          phone: null,
          relationship: null,
        },
      },

      identification: tenantData.identification || {
        idNumber: null,
        idType: null,
        idDocumentUrl: null,
      },

      notes: tenantData.notes || {
        moveInNotes: 'New tenant added via mobile app',
        specialTerms: null,
        restrictions: null,
      },

      utilityFees: tenantData.utilityFees || unit.utilityFees || {
        garbageFee: 0,
        waterBill: 0,
        electricity: 0,
        other: 0,
      },

      rentDeposit: {
        amount: tenantData.isExistingTenant ? 0 : (unit.depositAmount || 0),
        status: tenantData.isExistingTenant ? DEPOSIT_STATUS.NOT_REQUIRED : DEPOSIT_STATUS.PENDING,
        paidDate: null,
        refundStatus: 'not_applicable',
      },
    };

    // Calculate initial financial state
    // FIX: Fetch actual water bills if individual meter
    // FIX: Fetch actual water bills if individual meter
    const tempPropertyRef = doc(db, 'properties', unit.propertyId);
    const tempPropertySnap = await getDoc(tempPropertyRef);
    const tempPropertyData = tempPropertySnap.exists() ? tempPropertySnap.data() : {};
    const waterMeterType = tempPropertyData.waterMeterSettings?.meterType || 'single';

    let waterBillAmount = completeTenantData.utilityFees.waterBill || 0;

    if (waterMeterType === 'individual') {
      const currentMonth = getCurrentMonth();
      try {
        const waterBillRef = doc(db, 'water_bills', `${unit.propertyId}_${currentMonth}`);
        const waterBillSnap = await getDoc(waterBillRef);

        if (waterBillSnap.exists()) {
          const waterBillData = waterBillSnap.data();
          const unitBill = waterBillData.bills?.find(b => b.unitId === unit.unitId);
          if (unitBill) {
            waterBillAmount = parseFloat(unitBill.totalBill) || 0;
            // Update the utility fees object
            if (completeTenantData.utilityFees) {
              completeTenantData.utilityFees.waterBill = waterBillAmount;
            }
          }
        }
      } catch (err) {
        console.warn('Failed to fetch initial water bill:', err);
      }
    }

    const utilityFeesData = completeTenantData.utilityFees;
    const totalUtilityFees = (utilityFeesData.garbageFee || 0) +
      waterBillAmount +
      (utilityFeesData.electricity || 0) +
      (utilityFeesData.other || 0);

    const rentAmount = unit.rentAmount || 0;
    const depositAmountToPay = completeTenantData.rentDeposit.amount;

    const totalInitialDue = rentAmount + totalUtilityFees + depositAmountToPay;

    // Add financial fields to completeTenantData
    completeTenantData.arrears = totalInitialDue;
    completeTenantData.financialSummary = {
      totalPaid: 0,
      arrears: totalInitialDue,
      balance: -totalInitialDue, // Negative balance indicates amount due
    };

    // Initialize monthly tracking
    completeTenantData.monthlyPaymentTracking = {
      month: getCurrentMonth(),
      expectedAmount: totalInitialDue,
      paidAmount: 0,
      remainingAmount: totalInitialDue,
      status: PAYMENT_STATUS.UNPAID,
      payments: [],
      breakdown: {
        deposit: depositAmountToPay,
        rent: rentAmount,
        utilities: totalUtilityFees
      },
      includesDeposit: !tenantData.isExistingTenant,
      depositRequired: depositAmountToPay
    };


    let tenantId;
    let isNewTenant = false;

    if (id) {
      Object.keys(completeTenantData).forEach(key =>
        completeTenantData[key] === undefined && delete completeTenantData[key]
      );
      await updateDoc(doc(db, 'tenants', id), completeTenantData);
      tenantId = id;
    } else {
      const tenantRef = await addDoc(collection(db, 'tenants'), completeTenantData);
      tenantId = tenantRef.id;
      isNewTenant = true;
    }

    // Link tenant to unit
    await updateDoc(doc(db, 'units', unitDoc.id), {
      tenantId,
      isVacant: false,
    });

    // Update property stats
    const propertyRef = doc(db, 'properties', unit.propertyId);
    const propertySnap = await getDoc(propertyRef);

    if (propertySnap.exists()) {
      const propertyData = propertySnap.data();
      const newVacantCount = Math.max((propertyData.propertyVacantUnits || 1) - 1, 0);
      const newRevenue = (propertyData.propertyRevenueTotal || 0) + (unit.rentAmount || 0);

      await updateDoc(propertyRef, {
        propertyVacantUnits: newVacantCount,
        propertyRevenueTotal: newRevenue,
      });
    }

    // Create initial payment log
    if (isNewTenant) {
      try {
        await addDoc(collection(db, 'paymentLogs'), {
          tenantId,
          unitCode,
          propertyId: unit.propertyId,
          type: 'rent_due',
          amount: unit.rentAmount || 0,
          dueDate: completeTenantData.paymentTimeline.nextPaymentDate,
          status: PAYMENT_STATUS.PENDING,
          createdAt: now,
          month: getCurrentMonth(),
        });
      } catch (logError) {
        console.warn('⚠️ Failed to create payment log:', logError.message);
      }
    }

    // Send welcome SMS
    if (isNewTenant) {
      await this._sendWelcomeSMS(tenantId, completeTenantData, unit, phone, now);
    }

    return {
      tenantId,
      name: completeTenantData.name,
      unitCode: completeTenantData.unitCode,
      propertyId: completeTenantData.propertyId,
      moveInDate: completeTenantData.moveInDate,
      financialSummary: completeTenantData.financialSummary,
      depositInfo: {
        amount: depositAmount,
        status: completeTenantData.rentDeposit.status,
      },
      welcomeSMSSent: isNewTenant,
      durationMs: Date.now() - start,
    };
  }

  async _sendWelcomeSMS(tenantId, tenantData, unit, phone, now) {
    try {
      let formattedPhoneForSMS = phone.trim();
      if (formattedPhoneForSMS.startsWith('0')) {
        formattedPhoneForSMS = '+254' + formattedPhoneForSMS.substring(1);
      } else if (!formattedPhoneForSMS.startsWith('+254') && !formattedPhoneForSMS.startsWith('254')) {
        formattedPhoneForSMS = '+254' + formattedPhoneForSMS;
      }

      // Fetch property to get water meter settings
      const propertyRef = doc(db, 'properties', unit.propertyId);
      const propertySnap = await getDoc(propertyRef);
      const property = propertySnap.exists() ? propertySnap.data() : {};
      const waterMeterType = property.waterMeterSettings?.meterType || 'single';

      const utilityFeesData = tenantData.utilityFees;
      const garbageFee = utilityFeesData.garbageFee || 0;
      const waterFee = utilityFeesData.waterBill || 0;
      const electricityFee = utilityFeesData.electricity || 0;
      const otherFee = utilityFeesData.other || 0;
      const totalUtilityFees = garbageFee + waterFee + electricityFee + otherFee;
      const nonWaterUtilityFees = garbageFee + electricityFee + otherFee;
      const rentAmount = unit.rentAmount || 0;
      const totalMonthlyCharge = rentAmount + totalUtilityFees;
      // Use the actual deposit amount set on the tenant record (will be 0 for existing tenants)
      const depositAmount = tenantData.rentDeposit ? tenantData.rentDeposit.amount : (unit.depositAmount || 0);

      // Fetch paybill from settings
      const settingsService = require('./settingsService');
      const settings = await settingsService.getSettings();

      const paymentInfo = {
        paybill: settings.paybill,
        accountNumber: phone.trim().startsWith('0') ? phone.trim() : `0${phone.trim().replace(/^\+254/, '').replace(/^254/, '')}`,
      };

      const tenantSMSData = {
        name: tenantData.name,
        unitCode: tenantData.unitCode,
        unitName: unit.unitName || unit.unitId,
        rentAmount: rentAmount,
        utilityFees: totalUtilityFees,
        nonWaterUtilityFees: nonWaterUtilityFees,
        waterFee: waterFee,
        totalAmount: totalMonthlyCharge,
        depositAmount: depositAmount,
        phone: phone.trim(),
        waterMeterType: waterMeterType,
      };

      const welcomeMessage = smsService.generateTenantWelcomeSMS(tenantSMSData, paymentInfo);
      const smsResult = await smsService.sendSMS(
        formattedPhoneForSMS,
        welcomeMessage,
        'system',
        tenantId
      );

      if (smsResult.success) {
        await updateDoc(doc(db, 'tenants', tenantId), {
          welcomeSMSSent: true,
          welcomeSMSMessageId: smsResult.messageId,
          welcomeSMSSentAt: now,
        });
      } else {
        await updateDoc(doc(db, 'tenants', tenantId), {
          welcomeSMSSent: false,
          welcomeSMSError: smsResult.error,
          welcomeSMSAttemptedAt: now,
        });
      }
    } catch (smsError) {
      console.error('❌ Error sending welcome SMS:', smsError.message);
    }
  }

  async deleteTenant(tenantId) {
    const start = Date.now();

    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);

    if (!tenantSnap.exists()) {
      throw new Error('Tenant not found');
    }

    const tenantData = tenantSnap.data();

    // Get unit
    const unitsQuery = query(
      collection(db, 'units'),
      where('unitId', '==', tenantData.unitCode)
    );
    const unitsSnapshot = await getDocs(unitsQuery);

    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc?.data();

    // Update unit
    if (unitDoc) {
      await updateDoc(doc(db, 'units', unitDoc.id), {
        tenantId: null,
        isVacant: true,
      });
    }

    // Update property stats
    const propertyRef = doc(db, 'properties', tenantData.propertyId);
    const propertySnap = await getDoc(propertyRef);

    if (propertySnap.exists()) {
      const propertyData = propertySnap.data();
      const newVacantCount = (propertyData.propertyVacantUnits || 0) + 1;
      const rentAmount = unit?.rentAmount || 0;
      const newRevenue = Math.max((propertyData.propertyRevenueTotal || 0) - rentAmount, 0);

      await updateDoc(propertyRef, {
        propertyVacantUnits: newVacantCount,
        propertyRevenueTotal: newRevenue,
      });
    }

    // Delete tenant
    await deleteDoc(tenantRef);

    // Update payment logs
    try {
      const paymentLogsQuery = query(
        collection(db, 'paymentLogs'),
        where('tenantId', '==', tenantId),
        where('status', '==', PAYMENT_STATUS.PENDING)
      );
      const paymentLogsSnapshot = await getDocs(paymentLogsQuery);

      const updatePromises = paymentLogsSnapshot.docs.map((doc) =>
        updateDoc(doc.ref, {
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          cancelReason: 'Tenant deleted',
        })
      );

      await Promise.all(updatePromises);
    } catch (logError) {
      console.warn('⚠️ Failed to update payment logs:', logError.message);
    }

    return {
      tenantId,
      name: tenantData.name,
      unitCode: tenantData.unitCode,
      deletedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
    };
  }

  async sendReminder(tenantId) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);

    if (!tenantSnap.exists()) {
      throw new Error('Tenant not found');
    }

    const tenant = tenantSnap.data();

    if (!tenant.arrears || tenant.arrears <= 0) {
      throw new Error('No arrears for this tenant');
    }

    // Get current settings for paybill info
    const settingsSnap = await getDoc(doc(db, 'settings', 'general'));
    const settings = settingsSnap.exists() ? settingsSnap.data() : { paybill: '4082260' };

    const paymentInfo = {
      paybill: settings.paybill,
      accountNumber: tenant.phone || tenant.unitCode
    };

    const tracking = tenant.monthlyPaymentTracking;
    const currentBreakdown = tracking?.breakdown || {};
    const targetMonth = getCurrentMonth();

    // Fetch unit and property to get latest water bill settings
    let waterBillAmount = tenant.utilityFees?.waterBill || 0;
    try {
      const unitsQuery = query(collection(db, 'units'), where('unitId', '==', tenant.unitCode));
      const unitsSnap = await getDocs(unitsQuery);

      if (!unitsSnap.empty) {
        const unitData = unitsSnap.docs[0].data();
        const propertySnap = await getDoc(doc(db, 'properties', unitData.propertyId));

        if (propertySnap.exists()) {
          const propData = propertySnap.data();
          const meterType = propData.waterMeterSettings?.meterType || 'single';

          if (meterType === 'individual') {
            // Fetch from water_bills collection
            const waterDocSnap = await getDoc(doc(db, 'water_bills', `${unitData.propertyId}_${targetMonth}`));
            if (waterDocSnap.exists()) {
              const billedUnit = waterDocSnap.data().bills?.find(b =>
                String(b.unitId) === String(unitData.unitId) || String(b.unitCode) === String(unitData.unitId)
              );
              if (billedUnit) waterBillAmount = parseFloat(billedUnit.totalBill) || 0;
            }
          } else {
            // Single meter - use property fixed bill
            const fixedWater = parseFloat(propData.waterMeterSettings?.fixedWaterBill);
            if (!isNaN(fixedWater)) waterBillAmount = fixedWater;
          }
        }
      }
    } catch (err) {
      console.warn('[REMINDER] Failed to fetch dynamic water bill, using tenant snapshot:', err.message);
    }

    const debt = {
      debtCode: tenant.unitCode,
      storeOwner: { name: tenant.name },
      remainingAmount: tenant.arrears,
      breakdown: {
        rent: currentBreakdown.rent || 0,
        water: waterBillAmount,
        utilities: tenant.utilityFees?.garbageFee || 0,
        deposit: currentBreakdown.deposit || 0
      }
    };

    const smsMessage = smsService.generateInvoiceSMS(debt, paymentInfo);
    const smsResult = await smsService.sendSMS(tenant.phone, smsMessage, tenant.id, tenant.unitCode);

    if (!smsResult.success) {
      throw new Error('Failed to send SMS: ' + smsResult.error);
    }

    return { messageId: smsResult.messageId };
  }

  async sendConfirmation(tenantId, amount) {
    if (!amount || amount <= 0) {
      throw new Error('Valid payment amount required');
    }

    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);

    if (!tenantSnap.exists()) {
      throw new Error('Tenant not found');
    }

    const tenant = tenantSnap.data();

    const debt = {
      debtCode: tenant.unitCode,
      storeOwner: { name: tenant.name },
      remainingAmount: tenant.arrears || 0,
    };

    const smsMessage = smsService.generatePaymentConfirmationSMS(debt, amount);
    const smsResult = await smsService.sendSMS(tenant.phone, smsMessage, tenant.id, tenant.unitCode);

    if (!smsResult.success) {
      throw new Error('Failed to send SMS: ' + smsResult.error);
    }

    // Update arrears
    const newArrears = Math.max(0, tenant.arrears - amount);
    await updateDoc(tenantRef, { arrears: newArrears });

    return { messageId: smsResult.messageId };
  }
}

module.exports = new TenantService();