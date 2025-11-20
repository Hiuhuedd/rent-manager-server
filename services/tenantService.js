
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
const smsService = require('./smsService');

class TenantService {
  async getAllTenants() {
    const snapshot = await getDocs(collection(db, 'tenants'));
    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        id: doc.id,
        ...data,
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
    const tenantRef = doc(db, 'tenants', id);
    const tenantSnap = await getDoc(tenantRef);
    
    if (!tenantSnap.exists()) {
      return null;
    }
    
    return { id: tenantSnap.id, ...tenantSnap.data() };
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
        
        const rent = parseFloat(unit.rentAmount) || 0;
        const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unit.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unit.depositAmount) || 0;
        
        const isNewTenant = isMovedInThisMonth(tenant.moveInDate);
        const depositPending = tenant.rentDeposit?.status === DEPOSIT_STATUS.PENDING;
        const includeDeposit = isNewTenant && depositPending && deposit > 0;
        
        const monthlyRent = rent + garbage + water;
        const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
        
        monthlyTracking = {
          month: currentMonth,
          expectedAmount: totalExpected,
          paidAmount: 0,
          remainingAmount: totalExpected,
          status: PAYMENT_STATUS.UNPAID,
          payments: [],
          breakdown: {
            deposit: 0,
            rent: 0,
            utilities: 0
          },
          includesDeposit: includeDeposit,
          depositRequired: includeDeposit ? deposit : 0
        };
        
        await updateDoc(tenantRef, {
          monthlyPaymentTracking: monthlyTracking,
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
      
      propertyDetails: tenantData.propertyDetails || {
        propertyId: unit.propertyId,
        propertyName: propertyDoc.exists() ? propertyDoc.data().propertyName : 'Unknown',
        unitCategory: unit.category || 'Unknown',
        rentAmount: unit.rentAmount || 0,
        depositAmount: depositAmount,
      },
      
      rentDeposit: tenantData.rentDeposit || {
        amount: depositAmount,
        status: depositAmount > 0 ? DEPOSIT_STATUS.PENDING : DEPOSIT_STATUS.NOT_REQUIRED,
        paidDate: null,
        refundStatus: depositAmount > 0 ? 'active' : 'not_applicable',
        notes: depositAmount > 0 ? `Security deposit of KSH ${depositAmount} required` : 'No deposit required',
      },
      
      paymentTimeline: tenantData.paymentTimeline || {
        leaseStartDate: now,
        leaseEndDate: null,
        rentDueDay: 1,
        nextPaymentDate: new Date(new Date().setMonth(new Date().getMonth() + 1, 1)).toISOString(),
        lastPaymentDate: null,
        paymentFrequency: 'monthly',
      },
      
      paymentLogs: tenantData.paymentLogs || [],
      
      financialSummary: tenantData.financialSummary || {
        totalPaid: 0,
        totalDue: unit.rentAmount || 0,
        arrears: unit.rentAmount || 0,
        balance: 0,
        depositAmount: depositAmount,
        depositStatus: depositAmount > 0 ? DEPOSIT_STATUS.PENDING : DEPOSIT_STATUS.NOT_REQUIRED,
        lastUpdated: now,
      },
      
      arrears: unit.rentAmount || 0,
      tenantStatus: tenantData.tenantStatus || TENANT_STATUS.ACTIVE,
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
      
      const utilityFeesData = tenantData.utilityFees;
      const totalUtilityFees = (utilityFeesData.garbageFee || 0) + 
                               (utilityFeesData.waterBill || 0) + 
                               (utilityFeesData.electricity || 0) + 
                               (utilityFeesData.other || 0);
      const rentAmount = unit.rentAmount || 0;
      const totalMonthlyCharge = rentAmount + totalUtilityFees;
      const depositAmount = unit.depositAmount || 0;
      
      const paymentInfo = {
        paybill: '522533',
        accountNumber: phone.trim().startsWith('0') ? phone.trim() : `0${phone.trim().replace(/^\+254/, '').replace(/^254/, '')}`,
      };

      const tenantSMSData = {
        name: tenantData.name,
        unitCode: tenantData.unitCode,
        rentAmount: rentAmount,
        utilityFees: totalUtilityFees,
        totalAmount: totalMonthlyCharge,
        depositAmount: depositAmount,
        phone: phone.trim(),
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

    const debt = {
      debtCode: tenant.unitCode,
      storeOwner: { name: tenant.name },
      remainingAmount: tenant.arrears,
      paymentMethod: 'mpesa',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const smsMessage = smsService.generateInvoiceSMS(debt, tenant.phone);
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