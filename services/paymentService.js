// ============================================
// FILE: src/services/paymentService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs, query, where } = require('firebase/firestore');
const { getCurrentMonth } = require('../utils/dateHelper');
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
   * Get aggregated payment data for a tenant in a specific month
   */
  async getTenantMonthlyPayments(tenantId, targetMonth) {
    const paymentsQuery = query(
      collection(db, 'financial_records'),
      where('tenantId', '==', tenantId),
      where('paymentMonth', '==', targetMonth)
    );
    
    const paymentsSnapshot = await getDocs(paymentsQuery);
    const payments = paymentsSnapshot.docs.map(doc => doc.data());
    
    if (payments.length === 0) {
      return null;
    }
    
    // Get the most recent payment for monthly tracking status
    const sortedPayments = payments.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    
    const latestPayment = sortedPayments[0];
    
    return {
      totalPaid: payments.reduce((sum, p) => sum + p.amount, 0),
      paymentCount: payments.length,
      payments: sortedPayments,
      monthlyTracking: latestPayment.monthlyTracking,
      lastPaymentDate: latestPayment.timestamp
    };
  }

  async getPaymentStatus(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Getting payment status for: ${targetMonth}`);

    const unitsSnapshot = await getDocs(collection(db, 'units'));
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));

    const allUnits = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter units that existed in target month
    const units = allUnits.filter(unit => this.isRecordActiveInMonth(unit, targetMonth));
    
    // Filter tenants that existed in target month
    const tenants = allTenants.filter(tenant => this.isRecordActiveInMonth(tenant, targetMonth));

    const status = [];

    for (const unit of units) {
      const tenant = tenants.find(t => t.unitCode === unit.code);
      
      if (!tenant) {
        status.push({
          unitCode: unit.code,
          month: targetMonth,
          status: 'Vacant',
          amount: 0,
          tenant: 'Vacant',
        });
        continue;
      }
      
      const monthlyPayments = await this.getTenantMonthlyPayments(tenant.id, targetMonth);
      
      status.push({
        unitCode: unit.code,
        month: targetMonth,
        status: monthlyPayments ? 'Paid' : 'Unpaid',
        amount: monthlyPayments ? monthlyPayments.totalPaid : 0,
        tenant: tenant.name,
        paymentStatus: monthlyPayments?.monthlyTracking?.status || 'unpaid'
      });
    }

    return status;
  }

  async getPaymentVolume(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Getting payment volume for: ${targetMonth}`);

    const propertiesSnapshot = await getDocs(collection(db, 'properties'));
    const allProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter properties that existed in target month
    const properties = allProperties.filter(property => 
      this.isRecordActiveInMonth(property, targetMonth)
    );

    // Get all financial records for the target month
    const financialRecordsQuery = query(
      collection(db, 'financial_records'),
      where('paymentMonth', '==', targetMonth)
    );
    const financialRecordsSnapshot = await getDocs(financialRecordsQuery);
    const monthPayments = financialRecordsSnapshot.docs.map(doc => doc.data());

    const volume = [];

    properties.forEach(property => {
      const propertyPayments = monthPayments.filter(p => p.propertyId === property.id);
      
      const total = propertyPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

      if (total > 0) {
        volume.push({
          property: property.name,
          month: targetMonth,
          total,
          paymentCount: propertyPayments.length
        });
      }
    });

    return volume;
  }

  async getMonthlyReport(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`📊 Generating monthly report for: ${targetMonth}`);
    
    const [year, monthNum] = targetMonth.split('-').map(Number);

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

    // Get all financial records for the target month
    const financialRecordsQuery = query(
      collection(db, 'financial_records'),
      where('paymentMonth', '==', targetMonth)
    );
    const financialRecordsSnapshot = await getDocs(financialRecordsQuery);
    
    // Group financial records by tenant
    const paymentsByTenant = new Map();
    financialRecordsSnapshot.docs.forEach(doc => {
      const record = doc.data();
      if (!paymentsByTenant.has(record.tenantId)) {
        paymentsByTenant.set(record.tenantId, []);
      }
      paymentsByTenant.get(record.tenantId).push(record);
    });

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
      const unit = unitsMap.get(tenant.unitCode);
      if (!unit) {
        console.warn(`⚠️ Unit ${tenant.unitCode} not found for tenant ${tenant.name}`);
        continue;
      }

      const tenantPayments = paymentsByTenant.get(tenant.id) || [];
      
      // Calculate expected amounts for this month
      const rent = parseFloat(unit.rentAmount) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;
      const deposit = parseFloat(unit.depositAmount) || 0;
      
      // Check if deposit should be included this month
      const moveInDate = tenant.moveInDate ? new Date(tenant.moveInDate) : null;
      const moveInYear = moveInDate?.getFullYear();
      const moveInMonth = moveInDate ? moveInDate.getMonth() + 1 : null;
      const isFirstMonth = moveInYear === year && moveInMonth === monthNum;
      const depositPending = tenant.rentDeposit?.status === 'pending';
      const includeDeposit = isFirstMonth && depositPending;
      
      const monthlyRent = rent + garbage + water;
      const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
      
      // Get tracking data from most recent payment or calculate fresh
      let tracking;
      if (tenantPayments.length > 0) {
        // Sort by timestamp descending
        const sortedPayments = tenantPayments.sort((a, b) => 
          new Date(b.timestamp) - new Date(a.timestamp)
        );
        tracking = sortedPayments[0].monthlyTracking;
      } else {
        // No payments for this month
        tracking = {
          expectedTotal: totalExpected,
          totalPaid: 0,
          remainingAmount: totalExpected,
          status: PAYMENT_STATUS.UNPAID,
          breakdown: {
            deposit: {
              required: includeDeposit ? deposit : 0,
              paid: 0,
              remaining: includeDeposit ? deposit : 0
            },
            rent: {
              required: rent,
              paid: 0,
              remaining: rent
            },
            utilities: {
              required: garbage + water,
              paid: 0,
              remaining: garbage + water
            }
          }
        };
      }
      
      report.summary.totalTenants++;
      report.summary.totalExpected += tracking.expectedTotal || 0;
      report.summary.totalReceived += tracking.totalPaid || 0;
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
        expected: tracking.expectedTotal || 0,
        paid: tracking.totalPaid || 0,
        remaining: tracking.remainingAmount || 0,
        breakdown: {
          deposit: tracking.breakdown?.deposit?.paid || 0,
          rent: tracking.breakdown?.rent?.paid || 0,
          utilities: tracking.breakdown?.utilities?.paid || 0
        },
        payments: tenantPayments.map(p => ({
          transactionId: p.transactionId,
          amount: p.amount,
          date: p.paymentDate,
          timestamp: p.timestamp,
          allocation: p.allocation
        })),
        moveInDate: tenant.moveInDate,
        moveOutDate: tenant.moveOutDate
      });
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
    
    // Get financial records for the target month
    const financialRecordsQuery = query(
      collection(db, 'financial_records'),
      where('paymentMonth', '==', targetMonth)
    );
    const financialRecordsSnapshot = await getDocs(financialRecordsQuery);
    
    const paymentsByTenant = new Map();
    financialRecordsSnapshot.docs.forEach(doc => {
      const record = doc.data();
      if (!paymentsByTenant.has(record.tenantId)) {
        paymentsByTenant.set(record.tenantId, []);
      }
      paymentsByTenant.get(record.tenantId).push(record);
    });
    
    const overdueList = [];
    const [year, monthNum] = targetMonth.split('-').map(Number);
    
    for (const tenant of activeTenants) {
      const unit = unitsMap.get(tenant.unitCode);
      if (!unit) continue;

      const tenantPayments = paymentsByTenant.get(tenant.id) || [];
      
      // Calculate expected amounts
      const rent = parseFloat(unit.rentAmount) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;
      const deposit = parseFloat(unit.depositAmount) || 0;
      
      const moveInDate = tenant.moveInDate ? new Date(tenant.moveInDate) : null;
      const moveInYear = moveInDate?.getFullYear();
      const moveInMonth = moveInDate ? moveInDate.getMonth() + 1 : null;
      const isFirstMonth = moveInYear === year && moveInMonth === monthNum;
      const depositPending = tenant.rentDeposit?.status === 'pending';
      const includeDeposit = isFirstMonth && depositPending;
      
      const monthlyRent = rent + garbage + water;
      const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
      
      let tracking;
      if (tenantPayments.length > 0) {
        const sortedPayments = tenantPayments.sort((a, b) => 
          new Date(b.timestamp) - new Date(a.timestamp)
        );
        tracking = sortedPayments[0].monthlyTracking;
      } else {
        tracking = {
          expectedTotal: totalExpected,
          totalPaid: 0,
          remainingAmount: totalExpected,
          status: PAYMENT_STATUS.UNPAID
        };
      }
      
      if (tracking.status !== PAYMENT_STATUS.PAID) {
        overdueList.push({
          tenantId: tenant.id,
          name: tenant.name,
          phone: tenant.phone,
          unitCode: tenant.unitCode,
          propertyName: tenant.propertyDetails?.propertyName || 'N/A',
          expectedAmount: tracking.expectedTotal || 0,
          paidAmount: tracking.totalPaid || 0,
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
      .filter(t => (t.financialSummary?.arrears || t.arrears || 0) > 0)
      .map(t => ({
        tenant: t.name,
        unitCode: t.unitCode,
        amount: t.financialSummary?.arrears || t.arrears,
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

    const overdueData = await this.getOverduePayments(targetMonth);
    const overdueTenants = overdueData.tenants;
    
    const remindersSent = [];
    const remindersFailed = [];
    
    for (const tenantData of overdueTenants) {
      try {
        const debt = {
          debtCode: tenantData.unitCode,
          storeOwner: { name: tenantData.name },
          remainingAmount: tenantData.remainingAmount,
          paymentMethod: 'mpesa',
          dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        };
        
        const smsMessage = smsService.generateInvoiceSMS(debt, tenantData.phone);
        const smsResult = await smsService.sendSMS(tenantData.phone, smsMessage, tenantData.tenantId, tenantData.unitCode);
        
        if (smsResult.success) {
          remindersSent.push({
            tenantId: tenantData.tenantId,
            name: tenantData.name,
            phone: tenantData.phone,
            amount: tenantData.remainingAmount,
            messageId: smsResult.messageId
          });
          
          await updateDoc(doc(db, 'tenants', tenantData.tenantId), {
            lastReminderSent: new Date().toISOString(),
            reminderCount: (tenantData.reminderCount || 0) + 1
          });
        } else {
          remindersFailed.push({
            tenantId: tenantData.tenantId,
            name: tenantData.name,
            error: smsResult.error
          });
        }
      } catch (error) {
        remindersFailed.push({
          tenantId: tenantData.tenantId,
          name: tenantData.name,
          error: error.message
        });
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