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



  isRecordActiveInMonth(record, targetMonth) {
    const [year, month] = targetMonth.split('-').map(Number);
    const monthStart = new Date(year, month - 1, 1);
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);

    const createdAt = record.createdAt ? new Date(record.createdAt) : null;
    if (createdAt && createdAt > monthEnd) return false;

    const deletedAt = record.deletedAt || record.vacatedDate;
    if (deletedAt && new Date(deletedAt) < monthStart) return false;

    if (record.moveInDate && new Date(record.moveInDate) > monthEnd) return false;
    if (record.moveOutDate && new Date(record.moveOutDate) < monthStart) return false;

    return true;
  }

  async getMonthlyReport(month) {
    const targetMonth = month || getCurrentMonth();
    console.log(`Generating monthly report for: ${targetMonth}`);

    const tenantsSnap = await getDocs(collection(db, 'tenants'));
    const unitsSnap = await getDocs(collection(db, 'units'));
    const propertiesSnap = await getDocs(collection(db, 'properties'));

    const tenants = tenantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const units = unitsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const properties = propertiesSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const activeTenants = tenants.filter(t => this.isRecordActiveInMonth(t, targetMonth));
    const unitsMap = new Map(units.map(u => [u.unitId || u.code, u]));
    const propertiesMap = new Map(properties.map(p => [p.id, p]));

    const report = {
      month: targetMonth,
      summary: {
        totalTenants: 0,
        paidInFull: 0,
        partialPayment: 0,
        unpaid: 0,
        totalExpected: 0,
        totalReceived: 0,
        totalRemaining: 0,
        totalArrears: 0
      },
      tenants: []
    };

    for (const tenant of activeTenants) {
      const unit = unitsMap.get(tenant.unitCode);
      if (!unit) continue;

      let tracking = tenant.monthlyPaymentTracking;
      if (!tracking || tracking.month !== targetMonth) continue; // Only show if tracking exists

      report.summary.totalTenants++;
      report.summary.totalExpected += tracking.expectedAmount || 0;
      report.summary.totalReceived += tracking.paidAmount || 0;
      report.summary.totalRemaining += tracking.remainingAmount || 0;
      report.summary.totalArrears += tenant.financialSummary?.arrears || 0;

      if (tracking.status === PAYMENT_STATUS.PAID) report.summary.paidInFull++;
      else if (tracking.status === PAYMENT_STATUS.PARTIAL) report.summary.partialPayment++;
      else report.summary.unpaid++;

      const property = propertiesMap.get(tenant.propertyId);

      report.tenants.push({
        tenantId: tenant.id,
        name: tenant.name,
        phone: tenant.phone,
        unitCode: tenant.unitCode,
        propertyName: property?.propertyName || 'Unknown',
        status: tracking.status,
        expected: tracking.expectedAmount || 0,
        paid: tracking.paidAmount || 0,
        remaining: tracking.remainingAmount || 0,
        arrears: tenant.financialSummary?.arrears || 0,
        breakdown: tracking.breakdown || { deposit: 0, rent: 0, utilities: 0 },
        payments: tracking.payments || []
      });
    }

    return report;
  }

  async getOverduePayments(month) {
    const targetMonth = month || getCurrentMonth();
    const report = await this.getMonthlyReport(targetMonth);
    const overdue = report.tenants.filter(t => t.status !== 'paid');

    return {
      month: targetMonth,
      count: overdue.length,
      totalRemaining: report.summary.totalRemaining,
      tenants: overdue
    };
  }

  async getArrears(month) {
    const targetMonth = month || getCurrentMonth();
    const tenantsSnap = await getDocs(collection(db, 'tenants'));
    const tenants = tenantsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const activeTenants = tenants.filter(t => this.isRecordActiveInMonth(t, targetMonth));
    const totalArrears = activeTenants.reduce((sum, t) => sum + (t.financialSummary?.arrears || 0), 0);

    return {
      month: targetMonth,
      totalArrears,
      tenants: activeTenants
        .filter(t => (t.financialSummary?.arrears || 0) > 0)
        .map(t => ({
          name: t.name,
          phone: t.phone,
          unitCode: t.unitCode,
          arrears: t.financialSummary?.arrears || 0
        }))
    };
  }



}

module.exports = new PaymentService();