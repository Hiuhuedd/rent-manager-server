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
  async getAllTenants(agencyId, assignedProperties = null, userUid = null) {
    const currentMonth = getCurrentMonth();
    
    let accessiblePropertyIds = [];

    if (userUid || assignedProperties) {
      // Subagent Case: Get properties they can access
      const propertyService = require('./propertyService');
      const props = await propertyService.getAllProperties(agencyId, assignedProperties, userUid);
      accessiblePropertyIds = props.map(p => p.propertyId);
      
      if (accessiblePropertyIds.length === 0) return [];
    }

    // Fetch tenants, financial records, and units in parallel
    const tenantsQuery = (accessiblePropertyIds.length > 0)
        ? query(collection(db, 'tenants'), where('agencyId', '==', agencyId), where('propertyId', 'in', accessiblePropertyIds))
        : query(collection(db, 'tenants'), where('agencyId', '==', agencyId));

    const paymentsQuery = (accessiblePropertyIds.length > 0)
        ? query(collection(db, 'financial_records'), where('agencyId', '==', agencyId), where('paymentMonth', '==', currentMonth), where('propertyId', 'in', accessiblePropertyIds))
        : query(collection(db, 'financial_records'), where('agencyId', '==', agencyId), where('paymentMonth', '==', currentMonth));

    const unitsQuery = (accessiblePropertyIds.length > 0)
        ? query(collection(db, 'units'), where('agencyId', '==', agencyId), where('propertyId', 'in', accessiblePropertyIds))
        : query(collection(db, 'units'), where('agencyId', '==', agencyId));

    const [tenantsSnapshot, paymentsSnapshot, unitsSnapshot] = await Promise.all([
      getDocs(tenantsQuery),
      getDocs(paymentsQuery),
      getDocs(unitsQuery)
    ]);

    const unitMap = {};
    unitsSnapshot.forEach(doc => {
      const u = doc.data();
      const name = u.unitName || u.unitId || u.unitCode;
      if (u.unitId) unitMap[u.unitId] = name;
      if (u.unitCode) unitMap[u.unitCode] = name;
    });

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
      const effectiveArrears = (data.financialSummary?.arrears || data.arrears || 0);
      const unitDisplayName = unitMap[data.unitCode] || data.unitCode;

      return {
        id: doc.id,
        ...data,
        unitName: unitDisplayName,
        arrears: effectiveArrears,
        paidThisMonth,
        rentDeposit: data.rentDeposit || { amount: 0, status: DEPOSIT_STATUS.NOT_REQUIRED },
        utilityFees: data.utilityFees || { garbageFee: 0, waterBill: 0, electricity: 0, other: 0 },
        financialSummary: data.financialSummary || { totalPaid: 0, arrears: 0, balance: 0 }
      };
    });
  }

  async getTenantById(id, agencyId, accessiblePropertyIds = null) {
    const tenantRef = doc(db, 'tenants', id);
    const tenantSnap = await getDoc(tenantRef);
    
    if (!tenantSnap.exists()) return null;
    const tenantData = tenantSnap.data();

    // Security Check
    if (agencyId && tenantData.agencyId !== agencyId) {
      throw new Error('Unauthorized: Tenant does not belong to your agency');
    }

    if (accessiblePropertyIds && !accessiblePropertyIds.includes(tenantData.propertyId)) {
        throw new Error('Unauthorized: You do not have access to this property');
    }

    // Refresh status/tracking for this month
    await this.getPaymentStatus(id);
    const refreshedSnap = await getDoc(tenantRef);

    return {
      id: refreshedSnap.id,
      ...refreshedSnap.data()
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
        const electricity = parseFloat(unit.utilityFees?.electricityBill) || parseFloat(unit.utilityFees?.electricity) || 0;
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

        const monthlyRent = rent + garbage + water + electricity;
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
          allocatedUtilities = Math.min(remCarry, garbage + water + electricity);
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

        let newGlobalArrears;
        let newBalance;

        if (!tenant.monthlyPaymentTracking && isNewTenant) {
          // First-time tracking initialization for a tenant moving in this month:
          // The onboarding arrears and balance already include this initial expected month's bill, so do not double count.
          newGlobalArrears = tenant.arrears || tenant.financialSummary?.arrears || totalExpected;
          newBalance = tenant.financialSummary?.balance !== undefined ? tenant.financialSummary.balance : -newGlobalArrears;
        } else {
          newGlobalArrears = Math.max(0, (tenant.financialSummary?.arrears || tenant.arrears || 0) + totalExpected - carryOver);
          newBalance = existingBalance - totalExpected;
        }
        
        await updateDoc(tenantRef, {
          monthlyPaymentTracking: monthlyTracking,
          financialSummary: {
            totalPaid: tenant.financialSummary?.totalPaid || 0,
            arrears: newGlobalArrears,
            balance: newBalance
          },
          arrears: newGlobalArrears,
          updatedAt: new Date().toISOString()
        });
      }
    }

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
      financialSummary: tenant.financialSummary || { totalPaid: 0, arrears: 0, balance: 0 },
      depositStatus: tenant.rentDeposit?.status || DEPOSIT_STATUS.NOT_REQUIRED
    };
  }

  async createTenant(tenantData) {
    const start = Date.now();
    const { name, unitCode, phone } = tenantData;

    const unitsQuery = query(
      collection(db, 'units'), 
      where('unitId', '==', unitCode),
      where('agencyId', '==', tenantData.agencyId || 'default')
    );
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) throw new Error(`Unit ${unitCode} not found`);

    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc.data();
    const propertyDoc = await getDoc(doc(db, 'properties', unit.propertyId));

    const now = new Date().toISOString();
    const completeTenantData = {
      name: name.trim(),
      unitCode,
      phone: phone.trim(),
      propertyId: unit.propertyId,
      agencyId: tenantData.agencyId || unit.agencyId || 'default',
      propertyDetails: {
        propertyId: unit.propertyId,
        propertyName: propertyDoc.exists() ? propertyDoc.data().propertyName : 'Unknown',
        unitCategory: unit.category || 'Unknown',
      },
      moveInDate: tenantData.moveInDate || now,
      createdAt: now,
      updatedAt: now,
      rentDueDay: tenantData.rentDueDay || 1,
      rentDeposit: {
        amount: tenantData.isExistingTenant ? 0 : (unit.depositAmount || 0),
        status: tenantData.isExistingTenant ? DEPOSIT_STATUS.NOT_REQUIRED : DEPOSIT_STATUS.PENDING,
      },
      utilityFees: unit.utilityFees || { garbageFee: 0, waterBill: 0, electricity: 0, other: 0 }
    };

    const tempPropertyData = propertyDoc.exists() ? propertyDoc.data() : {};
    const waterMeterType = tempPropertyData.waterMeterSettings?.meterType || 'single';
    let waterBillAmount = completeTenantData.utilityFees.waterBill || 0;

    if (waterMeterType === 'individual') {
      try {
        const waterBillRef = doc(db, 'water_bills', `${unit.propertyId}_${getCurrentMonth()}`);
        const waterBillSnap = await getDoc(waterBillRef);
        if (waterBillSnap.exists()) {
          const unitBill = waterBillSnap.data().bills?.find(b => b.unitId === unit.unitId);
          if (unitBill) waterBillAmount = parseFloat(unitBill.totalBill) || 0;
        }
      } catch (err) {}
    }

    const totalInitialDue = (unit.rentAmount || 0) + (completeTenantData.utilityFees.garbageFee || 0) + waterBillAmount + (completeTenantData.utilityFees.electricity || 0) + completeTenantData.rentDeposit.amount;

    completeTenantData.arrears = totalInitialDue;
    completeTenantData.financialSummary = { totalPaid: 0, arrears: totalInitialDue, balance: -totalInitialDue };
    completeTenantData.monthlyPaymentTracking = {
      month: getCurrentMonth(),
      expectedAmount: totalInitialDue,
      paidAmount: 0,
      remainingAmount: totalInitialDue,
      status: PAYMENT_STATUS.UNPAID,
      breakdown: { deposit: completeTenantData.rentDeposit.amount, rent: unit.rentAmount || 0, utilities: totalInitialDue - (unit.rentAmount || 0) - completeTenantData.rentDeposit.amount }
    };

    const tenantRef = await addDoc(collection(db, 'tenants'), completeTenantData);
    await updateDoc(doc(db, 'units', unitDoc.id), { tenantId: tenantRef.id, isVacant: false });

    // Refresh property summary stats
    const propertyService = require('./propertyService');
    const propertyData = await propertyService.getPropertyById(unit.propertyId, tenantData.agencyId);
    if (propertyData) {
      const propertyRef = doc(db, 'properties', unit.propertyId);
      await updateDoc(propertyRef, {
        propertyOccupiedUnits: propertyData.propertyOccupiedUnits,
        propertyVacantUnits: propertyData.propertyVacantUnits,
        propertyRevenueTotal: propertyData.propertyRevenueTotal,
        updatedAt: new Date().toISOString()
      });
    }

    return { tenantId: tenantRef.id, ...completeTenantData };
  }

  async deleteTenant(tenantId) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) throw new Error('Tenant not found');

    const tenantData = tenantSnap.data();
    const unitsQuery = query(
      collection(db, 'units'), 
      where('unitId', '==', tenantData.unitCode),
      where('agencyId', '==', tenantData.agencyId)
    );
    const unitsSnapshot = await getDocs(unitsQuery);
    if (!unitsSnapshot.empty) {
      await updateDoc(doc(db, 'units', unitsSnapshot.docs[0].id), { tenantId: null, isVacant: true });
    }

    // Refresh property summary stats
    const propertyService = require('./propertyService');
    const propertyData = await propertyService.getPropertyById(tenantData.propertyId, tenantData.agencyId);
    if (propertyData) {
      const propertyRef = doc(db, 'properties', tenantData.propertyId);
      await updateDoc(propertyRef, {
        propertyOccupiedUnits: propertyData.propertyOccupiedUnits,
        propertyVacantUnits: propertyData.propertyVacantUnits,
        propertyRevenueTotal: propertyData.propertyRevenueTotal,
        updatedAt: new Date().toISOString()
      });
    }

    await deleteDoc(tenantRef);
    return { success: true };
  }

  async sendReminder(tenantId) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) throw new Error('Tenant not found');
    const tenant = tenantSnap.data();

    const settingsSnap = await getDoc(doc(db, 'settings', tenant.agencyId || 'default'));
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};

    const reminderService = require('./reminderService');
    const tenantDataForSMS = {
      name: tenant.name,
      unitName: tenant.unitCode || '',
      expected: tenant.arrears || 0,
      arrears: tenant.arrears || 0,
      phone: tenant.phone || '',
      customerServiceNumber: settings.customerServiceNumber || ''
    };

    const smsMessage = reminderService.generateReminderMessage(tenantDataForSMS, settings, tenant.id);
    const smsResult = await smsService.sendSMS(tenant.phone, smsMessage, tenant.agencyId, tenant.id, tenant.unitCode);
    return { messageId: smsResult.messageId };
  }

  async sendConfirmation(tenantId, amount) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) throw new Error('Tenant not found');
    const tenant = tenantSnap.data();

    const smsMessage = `Payment Received: KES ${amount} for ${tenant.unitCode}. Current Arrears: KES ${Math.max(0, tenant.arrears - amount)}.`;
    const smsResult = await smsService.sendSMS(tenant.phone, smsMessage, tenant.agencyId, tenant.id, tenant.unitCode);
    await updateDoc(tenantRef, { arrears: Math.max(0, tenant.arrears - amount) });
    return { messageId: smsResult.messageId };
  }

  async applyPenalty(tenantId, agencyId, sendSMS = true) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) throw new Error('Tenant not found');

    const tenant = tenantSnap.data();
    if (tenant.agencyId !== agencyId) throw new Error('Unauthorized');
    if (tenant.penaltyApplied) throw new Error('Penalty has already been applied to this tenant');

    // Fetch agency settings to calculate penalty
    const settingsSnap = await getDoc(doc(db, 'settings', agencyId));
    const settings = settingsSnap.exists() ? settingsSnap.data() : {};
    const penaltyConfig = settings.penalties || { active: false, type: 'flat', value: '500' };

    // Calculate penalty amount
    let penaltyAmount = 0;
    const value = parseFloat(penaltyConfig.value) || 0;
    
    let rentAmount = 0;
    if (tenant.monthlyPaymentTracking?.breakdown?.rent !== undefined) {
      let rawRent = tenant.monthlyPaymentTracking.breakdown.rent;
      // If for some legacy reason it's saved as an object in Firestore, try to extract amount
      if (typeof rawRent === 'object' && rawRent !== null) {
        rawRent = rawRent.amount || rawRent.value || 0;
      }
      rentAmount = parseFloat(rawRent);
    } 
    
    // Fallback if rent is still invalid or 0
    if (!rentAmount || isNaN(rentAmount)) {
      const unitsQuery = query(collection(db, 'units'), where('unitId', '==', tenant.unitCode));
      const unitsSnapshot = await getDocs(unitsQuery);
      if (!unitsSnapshot.empty) {
        rentAmount = parseFloat(unitsSnapshot.docs[0].data().rentAmount) || 0;
      } else {
        rentAmount = 0; // Default fallback
      }
    }

    if (penaltyConfig.type === 'percent') {
      penaltyAmount = rentAmount * (value / 100);
    } else {
      penaltyAmount = value;
    }

    if (penaltyAmount <= 0) {
      throw new Error('Late penalty protocol is disabled or penalty value is 0 in settings.');
    }

    // Apply updates to tenant doc
    const currentTracking = tenant.monthlyPaymentTracking || {};
    const updatedExpected = (currentTracking.expectedAmount || 0) + penaltyAmount;
    const updatedRemaining = (currentTracking.remainingAmount || 0) + penaltyAmount;
    const updatedArrears = (tenant.arrears || 0) + penaltyAmount;

    const updatedTracking = {
      ...currentTracking,
      expectedAmount: updatedExpected,
      remainingAmount: updatedRemaining,
      status: updatedRemaining > 0 ? (currentTracking.status === 'paid' ? 'partial' : currentTracking.status) : 'paid',
    };

    if (updatedTracking.breakdown) {
      updatedTracking.breakdown.penalties = (updatedTracking.breakdown.penalties || 0) + penaltyAmount;
    }

    const updates = {
      penaltyApplied: true,
      penaltyAmount: penaltyAmount,
      arrears: updatedArrears,
      monthlyPaymentTracking: updatedTracking,
      financialSummary: {
        totalPaid: tenant.financialSummary?.totalPaid || 0,
        arrears: updatedArrears,
        balance: (tenant.financialSummary?.balance || 0) - penaltyAmount
      },
      updatedAt: new Date().toISOString()
    };

    await updateDoc(tenantRef, updates);

    // Send SMS notifying the tenant of the applied penalty
    if (sendSMS && tenant.phone) {
      let paybillString = '';
      const methods = settings.paymentMethods || {};
      const activeMethods = [];

      if (parseInt(settings.mpesaIntegrationTier) === 3) {
          paybillString = `M-Pesa Paybill 4005473`;
      } else {
          if (methods.mpesaActive) {
              const channelType = methods.mpesaType === 'till' ? 'Till' : 'Paybill';
              activeMethods.push(`M-Pesa ${channelType} ${methods.mpesaNumber || settings.paybill || '522533'}`);
          }
          if (methods.bankActive) {
              activeMethods.push(`${methods.bankName || 'Bank'} A/C ${methods.bankAccountNumber || ''}`);
          }
          if (methods.cashActive && activeMethods.length === 0) {
              activeMethods.push('Cash remittance');
          }

          if (activeMethods.length > 0) {
              paybillString = activeMethods.join(' or ');
          } else {
              paybillString = `Paybill ${settings.paybill || '522533'}`;
          }
      }

      const formatPhoneAsAccount = (phone) => {
        if (!phone) return '';
        let clean = phone.trim().replace(/\s+/g, '').replace(/\+/g, '');
        if (clean.startsWith('254')) {
          clean = '0' + clean.substring(3);
        }
        if (!clean.startsWith('0') && clean.length >= 9) {
          clean = '0' + clean;
        }
        return clean;
      };
      
      const smsMessage = `Dear ${tenant.name || 'Tenant'}, a late rent penalty of KES ${penaltyAmount.toLocaleString()} has been applied to unit ${tenant.unitCode || ''}. Breakdown: Rent KES ${rentAmount.toLocaleString()}, Late Penalty KES ${penaltyAmount.toLocaleString()}. Total due: KES ${updatedArrears.toLocaleString()}. Please pay via ${paybillString}, Acc ${formatPhoneAsAccount(tenant.phone)}.`;
      
      try {
        await smsService.sendSMS(tenant.phone, smsMessage, agencyId, 'system_penalty', tenantId);
        console.log(`[SMS] Penalty notification sent to ${tenant.name} (${tenant.phone})`);
      } catch (smsErr) {
        console.error(`[SMS] Failed to send penalty SMS to ${tenant.name}:`, smsErr.message);
      }
    }

    return { success: true, penaltyAmount };
  }

  async removePenalty(tenantId, agencyId) {
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) throw new Error('Tenant not found');

    const tenant = tenantSnap.data();
    if (tenant.agencyId !== agencyId) throw new Error('Unauthorized');
    if (!tenant.penaltyApplied) throw new Error('No penalty has been applied to this tenant');

    const penaltyAmount = tenant.penaltyAmount || 0;

    // Apply updates to remove penalty
    const currentTracking = tenant.monthlyPaymentTracking || {};
    const updatedExpected = Math.max(0, (currentTracking.expectedAmount || 0) - penaltyAmount);
    const updatedRemaining = Math.max(0, (currentTracking.remainingAmount || 0) - penaltyAmount);
    const updatedArrears = Math.max(0, (tenant.arrears || 0) - penaltyAmount);

    const updatedTracking = {
      ...currentTracking,
      expectedAmount: updatedExpected,
      remainingAmount: updatedRemaining,
      status: updatedRemaining <= 0 ? 'paid' : (currentTracking.status === 'paid' ? 'partial' : currentTracking.status),
    };

    if (updatedTracking.breakdown && updatedTracking.breakdown.penalties) {
      updatedTracking.breakdown.penalties = Math.max(0, updatedTracking.breakdown.penalties - penaltyAmount);
    }

    const updates = {
      penaltyApplied: false,
      penaltyAmount: 0,
      arrears: updatedArrears,
      monthlyPaymentTracking: updatedTracking,
      financialSummary: {
        totalPaid: tenant.financialSummary?.totalPaid || 0,
        arrears: updatedArrears,
        balance: (tenant.financialSummary?.balance || 0) + penaltyAmount
      },
      updatedAt: new Date().toISOString()
    };

    await updateDoc(tenantRef, updates);
    return { success: true };
  }
}

module.exports = new TenantService();