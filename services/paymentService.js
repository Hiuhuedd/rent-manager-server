// ============================================
// FILE: src/services/paymentService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs, query, where } = require('firebase/firestore');
const { getCurrentMonth, isMovedInThisMonth } = require('../utils/dateHelper');
const { PAYMENT_STATUS } = require('../config/constants');
const smsService = require('./smsService');

class PaymentService {
  /**
   * Check if a record existed in the specified month
   */
  isRecordActiveInMonth(record, targetMonth) {
    const [year, month] = targetMonth.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

    // Check creation date
    const createdAt = record.createdAt ? new Date(record.createdAt) : null;
    if (createdAt && createdAt > monthEnd) {
      return false; // Created after target month
    }

    // Check deletion/deactivation date
    const deletedAt = record.deletedAt || record.deactivatedAt || record.vacatedDate;
    if (deletedAt) {
      const deletionDate = new Date(deletedAt);
      if (deletionDate < monthStart) {
        return false; // Deleted before target month
      }
    }

    // For tenants, check move-in and move-out dates
    if (record.moveInDate) {
      const moveInDate = new Date(record.moveInDate);
      if (moveInDate > monthEnd) {
        return false; // Moved in after target month
      }
    }

    if (record.moveOutDate) {
      const moveOutDate = new Date(record.moveOutDate);
      if (moveOutDate < monthStart) {
        return false; // Moved out before target month
      }
    }

    return true;
  }

  /**
   * Check if tenant should be charged deposit in the target month
   */
  shouldIncludeDepositForMonth(tenant, unit, targetMonth) {
    if (!tenant.moveInDate || !unit.depositAmount) {
      return false;
    }

    const [year, month] = targetMonth.split('-').map(Number);
    const moveInDate = new Date(tenant.moveInDate);
    const moveInYear = moveInDate.getFullYear();
    const moveInMonth = moveInDate.getMonth() + 1;

    // Deposit is only charged in the month tenant moved in
    if (moveInYear === year && moveInMonth === month) {
      const depositStatus = tenant.rentDeposit?.status || PAYMENT_STATUS.PENDING;
      return depositStatus === PAYMENT_STATUS.PENDING;
    }

    return false;
  }

  async getPaymentStatus(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Getting payment status for: ${targetMonth}`);

    const paymentsSnapshot = await getDocs(collection(db, 'rental_payments'));
    const unitsSnapshot = await getDocs(collection(db, 'units'));
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));

    const allUnits = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allPayments = paymentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter units that existed in target month
    const units = allUnits.filter(unit => this.isRecordActiveInMonth(unit, targetMonth));
    
    // Filter tenants that existed in target month
    const tenants = allTenants.filter(tenant => this.isRecordActiveInMonth(tenant, targetMonth));

    const status = [];

    units.forEach(unit => {
      const tenant = tenants.find(t => t.unitCode === unit.code);
      const unitPayments = allPayments.filter(p => 
        p.unitId === unit.id && 
        p.date?.slice(0, 7) === targetMonth
      );
      const payment = unitPayments.find(p => p.date.slice(0, 7) === targetMonth);

      status.push({
        unitCode: unit.code,
        month: targetMonth,
        status: payment ? 'Paid' : 'Unpaid',
        amount: payment ? payment.amount : 0,
        tenant: tenant ? tenant.name : 'Vacant',
      });
    });

    return status;
  }

  async getPaymentVolume(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Getting payment volume for: ${targetMonth}`);

    const paymentsSnapshot = await getDocs(collection(db, 'rental_payments'));
    const propertiesSnapshot = await getDocs(collection(db, 'properties'));

    const allPayments = paymentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter properties that existed in target month
    const properties = allProperties.filter(property => 
      this.isRecordActiveInMonth(property, targetMonth)
    );

    // Filter payments for target month
    const monthPayments = allPayments.filter(p => p.date?.slice(0, 7) === targetMonth);

    const volume = [];

    properties.forEach(property => {
      const propertyPayments = monthPayments.filter(p => p.propertyId === property.id);
      
      const total = propertyPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

      if (total > 0) {
        volume.push({
          property: property.name,
          month: targetMonth,
          total,
        });
      }
    });

    return volume;
  }

  async getMonthlyReport(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Generating monthly report for: ${targetMonth}`);
    
    const [year, monthNum] = targetMonth.split('-').map(Number);
    const monthStart = new Date(year, monthNum - 1, 1);
    const monthEnd = new Date(year, monthNum, 0, 23, 59, 59, 999);

    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const unitsSnapshot = await getDocs(collection(db, 'units'));
    const propertiesSnapshot = await getDocs(collection(db, 'properties'));

    const allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allUnits = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter records that existed in target month
    const activeTenants = allTenants.filter(tenant => 
      this.isRecordActiveInMonth(tenant, targetMonth)
    );
    
    const activeUnits = allUnits.filter(unit => 
      this.isRecordActiveInMonth(unit, targetMonth)
    );

    const activeProperties = allProperties.filter(property => 
      this.isRecordActiveInMonth(property, targetMonth)
    );

    console.log(`✅ Active records - Tenants: ${activeTenants.length}, Units: ${activeUnits.length}, Properties: ${activeProperties.length}`);

    const report = {
      month: targetMonth,
      summary: {
        totalTenants: 0,
        paidInFull: 0,
        partialPayment: 0,
        unpaid: 0,
        totalExpected: 0,
        totalReceived: 0,
        totalRemaining: 0
      },
      tenants: []
    };
    
    const unitsMap = new Map();
    activeUnits.forEach(unit => {
      unitsMap.set(unit.unitId || unit.code, unit);
    });

    const propertiesMap = new Map();
    activeProperties.forEach(property => {
      propertiesMap.set(property.id, property);
    });
    
    for (const tenant of activeTenants) {
      let tracking = tenant.monthlyPaymentTracking || null;
      
      // Verify tracking is for the correct month, otherwise recalculate
      if (!tracking || tracking.month !== targetMonth) {
        const unit = unitsMap.get(tenant.unitCode);
        if (!unit) {
          console.warn(`⚠️ Unit ${tenant.unitCode} not found for tenant ${tenant.name}`);
          continue;
        }

        const rent = parseFloat(unit.rentAmount) || 0;
        const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unit.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unit.depositAmount) || 0;
        
        const includeDeposit = this.shouldIncludeDepositForMonth(tenant, unit, targetMonth);
        
        const monthlyRent = rent + garbage + water;
        const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
        
        tracking = {
          month: targetMonth,
          expectedAmount: totalExpected,
          paidAmount: 0,
          remainingAmount: totalExpected,
          status: PAYMENT_STATUS.UNPAID,
          payments: [],
          breakdown: {
            deposit: includeDeposit ? deposit : 0,
            rent: rent,
            utilities: garbage + water
          }
        };
      }
      
      if (tracking && tracking.month === targetMonth) {
        report.summary.totalTenants++;
        report.summary.totalExpected += tracking.expectedAmount || 0;
        report.summary.totalReceived += tracking.paidAmount || 0;
        report.summary.totalRemaining += tracking.remainingAmount || 0;
        
        switch (tracking.status) {
          case PAYMENT_STATUS.PAID:
            report.summary.paidInFull++;
            break;
          case PAYMENT_STATUS.PARTIAL:
            report.summary.partialPayment++;
            break;
          case PAYMENT_STATUS.UNPAID:
            report.summary.unpaid++;
            break;
        }

        const property = propertiesMap.get(tenant.propertyId);
        
        report.tenants.push({
          tenantId: tenant.id,
          name: tenant.name,
          unitCode: tenant.unitCode,
          propertyName: property?.name || tenant.propertyDetails?.propertyName || 'N/A',
          status: tracking.status || PAYMENT_STATUS.UNPAID,
          expected: tracking.expectedAmount || 0,
          paid: tracking.paidAmount || 0,
          remaining: tracking.remainingAmount || 0,
          breakdown: tracking.breakdown || { deposit: 0, rent: 0, utilities: 0 },
          payments: tracking.payments || [],
          moveInDate: tenant.moveInDate,
          moveOutDate: tenant.moveOutDate
        });
      }
    }
    
    console.log(`✅ Report generated: ${report.summary.totalTenants} active tenants for ${targetMonth}`);
    return report;
  }

  async getOverduePayments(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Getting overdue payments for: ${targetMonth}`);

    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const unitsSnapshot = await getDocs(collection(db, 'units'));
    
    const allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allUnits = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter tenants active in target month
    const activeTenants = allTenants.filter(tenant => 
      this.isRecordActiveInMonth(tenant, targetMonth)
    );

    const activeUnits = allUnits.filter(unit => 
      this.isRecordActiveInMonth(unit, targetMonth)
    );
    
    const unitsMap = new Map();
    activeUnits.forEach(unit => {
      unitsMap.set(unit.unitId || unit.code, unit);
    });
    
    const overdueList = [];
    
    for (const tenant of activeTenants) {
      let tracking = tenant.monthlyPaymentTracking || null;
      
      if (!tracking || tracking.month !== targetMonth) {
        const unit = unitsMap.get(tenant.unitCode);
        if (!unit) continue;

        const rent = parseFloat(unit.rentAmount) || 0;
        const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unit.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unit.depositAmount) || 0;
        
        const includeDeposit = this.shouldIncludeDepositForMonth(tenant, unit, targetMonth);
        
        const monthlyRent = rent + garbage + water;
        const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
        
        tracking = {
          month: targetMonth,
          expectedAmount: totalExpected,
          paidAmount: 0,
          remainingAmount: totalExpected,
          status: PAYMENT_STATUS.UNPAID,
          payments: [],
          breakdown: { deposit: includeDeposit ? deposit : 0, rent: rent, utilities: garbage + water }
        };
      }
      
      if (tracking && tracking.month === targetMonth && tracking.status !== PAYMENT_STATUS.PAID) {
        overdueList.push({
          tenantId: tenant.id,
          name: tenant.name,
          phone: tenant.phone,
          unitCode: tenant.unitCode,
          propertyName: tenant.propertyDetails?.propertyName || 'N/A',
          expectedAmount: tracking.expectedAmount || 0,
          paidAmount: tracking.paidAmount || 0,
          remainingAmount: tracking.remainingAmount || 0,
          status: tracking.status || PAYMENT_STATUS.UNPAID,
          arrears: tenant.financialSummary?.arrears || tenant.arrears || 0,
          moveInDate: tenant.moveInDate,
          moveOutDate: tenant.moveOutDate
        });
      }
    }
    
    console.log(`📋 Found ${overdueList.length} tenants with incomplete payments for ${targetMonth}`);
    return {
      month: targetMonth,
      count: overdueList.length,
      tenants: overdueList
    };
  }

  async getArrears(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Getting arrears for: ${targetMonth}`);

    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const propertiesSnapshot = await getDocs(collection(db, 'properties'));

    const allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter records active in target month
    const activeTenants = allTenants.filter(tenant => 
      this.isRecordActiveInMonth(tenant, targetMonth)
    );

    const activeProperties = allProperties.filter(property => 
      this.isRecordActiveInMonth(property, targetMonth)
    );

    const arrears = activeTenants
      .filter(t => (t.arrears || 0) > 0)
      .map(t => ({
        tenant: t.name,
        unitCode: t.unitCode,
        amount: t.arrears,
        propertyId: t.propertyId,
      }));

    const totalByProperty = {};
    activeProperties.forEach(p => {
      totalByProperty[p.id] = {
        property: p.name,
        totalArrears: arrears
          .filter(a => a.propertyId === p.id)
          .reduce((sum, a) => sum + a.amount, 0),
      };
    });

    return {
      month: targetMonth,
      arrears: [...arrears, ...Object.values(totalByProperty)]
    };
  }

  async sendReminders(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Sending reminders for: ${targetMonth}`);

    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter tenants active in target month
    const activeTenants = allTenants.filter(tenant => 
      this.isRecordActiveInMonth(tenant, targetMonth)
    );
    
    const remindersSent = [];
    const remindersFailed = [];
    
    for (const tenant of activeTenants) {
      const tracking = tenant.monthlyPaymentTracking || {};
      
      if (tracking.month === targetMonth && tracking.status !== PAYMENT_STATUS.PAID) {
        try {
          const debt = {
            debtCode: tenant.unitCode,
            storeOwner: { name: tenant.name },
            remainingAmount: tracking.remainingAmount || 0,
            paymentMethod: 'mpesa',
            dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          };
          
          const smsMessage = smsService.generateInvoiceSMS(debt, tenant.phone);
          const smsResult = await smsService.sendSMS(tenant.phone, smsMessage, tenant.id, tenant.unitCode);
          
          if (smsResult.success) {
            remindersSent.push({
              tenantId: tenant.id,
              name: tenant.name,
              phone: tenant.phone,
              amount: tracking.remainingAmount,
              messageId: smsResult.messageId
            });
            
            await updateDoc(doc(db, 'tenants', tenant.id), {
              lastReminderSent: new Date().toISOString(),
              reminderCount: (tenant.reminderCount || 0) + 1
            });
          } else {
            remindersFailed.push({
              tenantId: tenant.id,
              name: tenant.name,
              error: smsResult.error
            });
          }
        } catch (error) {
          remindersFailed.push({
            tenantId: tenant.id,
            name: tenant.name,
            error: error.message
          });
        }
      }
    }
    
    console.log(`📱 Reminders sent: ${remindersSent.length}, Failed: ${remindersFailed.length}`);
    return {
      month: targetMonth,
      sent: remindersSent.length,
      failed: remindersFailed.length,
      details: {
        sent: remindersSent,
        failed: remindersFailed
      }
    };
  }
}

module.exports = new PaymentService();