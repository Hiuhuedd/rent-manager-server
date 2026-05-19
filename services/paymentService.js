// ============================================
// FILE: src/services/paymentService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs, getDoc, doc, query, where, updateDoc } = require('firebase/firestore');
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

    const toDate = (val) => {
      if (!val) return null;
      if (val.toDate) return val.toDate();
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };

    const createdAt = toDate(record.createdAt);
    if (createdAt && createdAt > monthEnd) return false;

    const deletedAt = toDate(record.deletedAt || record.deactivatedAt || record.vacatedDate);
    if (deletedAt && deletedAt < monthStart) return false;

    const moveInDate = toDate(record.moveInDate);
    if (moveInDate && moveInDate > monthEnd) return false;

    const moveOutDate = toDate(record.moveOutDate);
    if (moveOutDate && moveOutDate < monthStart) return false;

    return true;
  }

  async getTenantMonthlyPayments(tenantId, targetMonth, agencyId) {
    const paymentsQuery = query(
      collection(db, 'financial_records'),
      where('tenantId', '==', tenantId),
      where('paymentMonth', '==', targetMonth),
      where('agencyId', '==', agencyId)
    );

    const paymentsSnapshot = await getDocs(paymentsQuery);
    const payments = paymentsSnapshot.docs.map(doc => doc.data());

    if (payments.length === 0) return null;

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

  async getPaymentStatus(agencyId, month, assignedProperties = []) {
    if (!agencyId) return [];
    const targetMonth = month || getCurrentMonth();
    
    const unitsQuery = query(collection(db, 'units'), where('agencyId', '==', agencyId));
    const tenantsQuery = query(collection(db, 'tenants'), where('agencyId', '==', agencyId));

    const [unitsSnapshot, tenantsSnapshot] = await Promise.all([
      getDocs(unitsQuery),
      getDocs(tenantsQuery)
    ]);

    let allUnits = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    let allTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter by assigned properties if provided (null means admin/all)
    if (assignedProperties !== null) {
      allUnits = allUnits.filter(u => assignedProperties.includes(u.propertyId));
      allTenants = allTenants.filter(t => assignedProperties.includes(t.propertyId));
    }

    const units = allUnits.filter(unit => this.isRecordActiveInMonth(unit, targetMonth));
    const tenants = allTenants.filter(tenant => this.isRecordActiveInMonth(tenant, targetMonth));

    const status = [];

    for (const unit of units) {
      const tenant = tenants.find(t => t.unitCode === unit.unitId || t.unitCode === unit.code);

      if (!tenant) {
        status.push({
          unitCode: unit.unitName || unit.unitId,
          month: targetMonth,
          status: 'Vacant',
          amount: 0,
          tenant: 'Vacant',
        });
        continue;
      }

      const monthlyPayments = await this.getTenantMonthlyPayments(tenant.id, targetMonth, agencyId);

      status.push({
        unitCode: unit.unitName || unit.unitId,
        month: targetMonth,
        status: monthlyPayments ? 'Paid' : 'Unpaid',
        amount: monthlyPayments ? monthlyPayments.totalPaid : 0,
        tenant: tenant.name,
        paymentStatus: monthlyPayments?.monthlyTracking?.status || 'unpaid'
      });
    }

    return status;
  }

  async getPaymentVolume(agencyId, month, assignedProperties = []) {
    if (!agencyId) return [];
    const targetMonth = month || getCurrentMonth();

    const propertiesQuery = query(collection(db, 'properties'), where('agencyId', '==', agencyId));
    const propertiesSnapshot = await getDocs(propertiesQuery);
    let allProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    // Filter by assigned properties if provided (null means admin/all)
    if (assignedProperties !== null) {
      allProperties = allProperties.filter(p => assignedProperties.includes(p.id) || assignedProperties.includes(p.propertyId));
    }

    const properties = allProperties.filter(property =>
      this.isRecordActiveInMonth(property, targetMonth)
    );

    const financialRecordsQuery = query(
      collection(db, 'financial_records'),
      where('paymentMonth', '==', targetMonth),
      where('agencyId', '==', agencyId)
    );
    const financialRecordsSnapshot = await getDocs(financialRecordsQuery);
    const monthPayments = financialRecordsSnapshot.docs.map(doc => doc.data());

    const volume = [];

    properties.forEach(property => {
      const propertyPayments = monthPayments.filter(p => p.propertyId === property.propertyId || p.propertyId === property.id);
      const total = propertyPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

      if (total > 0) {
        volume.push({
          property: property.propertyName,
          month: targetMonth,
          total,
          paymentCount: propertyPayments.length
        });
      }
    });

    return volume;
  }

  async getMonthlyReport(agencyId, month, assignedProperties = []) {
    const targetMonth = month || getCurrentMonth();
    
    // Return empty report if agencyId is missing
    if (!agencyId) {
      return {
        month: targetMonth,
        summary: { totalTenants: 0, paidInFull: 0, partialPayment: 0, unpaid: 0, totalExpected: 0, totalReceived: 0, totalRemaining: 0, totalOverpaid: 0 },
        tenants: []
      };
    }

    const [year, monthNum] = targetMonth.split('-').map(Number);

    const tenantsQuery = query(collection(db, 'tenants'), where('agencyId', '==', agencyId));
    const unitsQuery = query(collection(db, 'units'), where('agencyId', '==', agencyId));
    const propertiesQuery = query(collection(db, 'properties'), where('agencyId', '==', agencyId));
    const financialRecordsQuery = query(
      collection(db, 'financial_records'), 
      where('paymentMonth', '==', targetMonth), 
      where('agencyId', '==', agencyId)
    );

    const [tenantsSnapshot, unitsSnapshot, propertiesSnapshot, financialRecordsSnapshot] = await Promise.all([
      getDocs(tenantsQuery),
      getDocs(unitsQuery),
      getDocs(propertiesQuery),
      getDocs(financialRecordsQuery)
    ]);

    let activeTenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(t => this.isRecordActiveInMonth(t, targetMonth));
    let activeUnits = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(u => this.isRecordActiveInMonth(u, targetMonth));
    let activeProperties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(p => this.isRecordActiveInMonth(p, targetMonth));

    // Filter by assigned properties if provided (null means admin/all)
    if (assignedProperties !== null) {
      activeTenants = activeTenants.filter(t => assignedProperties.includes(t.propertyId));
      activeUnits = activeUnits.filter(u => assignedProperties.includes(u.propertyId));
      activeProperties = activeProperties.filter(p => assignedProperties.includes(p.id) || assignedProperties.includes(p.propertyId));
    }

    const paymentsByTenant = new Map();
    financialRecordsSnapshot.docs.forEach(doc => {
      const record = doc.data();
      if (!paymentsByTenant.has(record.tenantId)) paymentsByTenant.set(record.tenantId, []);
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
        totalRemaining: 0,
        totalOverpaid: 0 
      },
      tenants: []
    };

    const unitsMap = new Map();
    const allUnitsRaw = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    allUnitsRaw.forEach(u => {
      const uName = String(u.unitName || u.unitId || '').toLowerCase().trim();
      const nameKey = `${u.propertyId}_${uName}`;
      unitsMap.set(nameKey, u);
      unitsMap.set(u.id, u);
      if (u.unitId) unitsMap.set(String(u.unitId).toLowerCase().trim(), u);
    });

    const propertiesMap = new Map();
    activeProperties.forEach(p => propertiesMap.set(p.propertyId || p.id, p));

    const toDate = (val) => {
      if (!val) return null;
      if (val.toDate) return val.toDate();
      const d = new Date(val);
      return isNaN(d.getTime()) ? null : d;
    };

    for (const tenant of activeTenants) {
      const uCode = String(tenant.unitCode || '').toLowerCase().trim();
      const nameKey = `${tenant.propertyId}_${uCode}`;
      let unit = unitsMap.get(nameKey) || unitsMap.get(uCode) || unitsMap.get(tenant.unitId) || unitsMap.get(tenant.id);
      
      if (!unit) continue;

      const tenantPayments = paymentsByTenant.get(tenant.id) || [];
      const unitProperty = propertiesMap.get(unit.propertyId);

      // Expected logic: include deposit if it's the first month
      const moveInDate = toDate(tenant.moveInDate);
      const movedInThisMonth = moveInDate && 
                               moveInDate.getMonth() === (monthNum - 1) && 
                               moveInDate.getFullYear() === year;

      const rent = parseFloat(unit.rentAmount || unit.rent) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;
      const electricity = parseFloat(unit.utilityFees?.electricityBill) || 0;
      const deposit = movedInThisMonth ? (parseFloat(unit.depositAmount || unit.deposit) || 0) : 0;
      const penaltyAmount = tenant.penaltyApplied ? (parseFloat(tenant.penaltyAmount) || 0) : 0;

      const breakdown = {
        rent,
        deposit,
        garbageFee: garbage,
        waterBill: water,
        electricityBill: electricity,
        penalties: penaltyAmount
      };

      // Merge from tenant's specific tracking if available, healing legacy zero-valued records
      const currentTracking = tenant.monthlyPaymentTracking || {};
      if (currentTracking.breakdown) {
        if (currentTracking.breakdown.rent) breakdown.rent = parseFloat(currentTracking.breakdown.rent) || breakdown.rent;
        if (currentTracking.breakdown.deposit) breakdown.deposit = parseFloat(currentTracking.breakdown.deposit) || breakdown.deposit;
        if (currentTracking.breakdown.garbageFee) breakdown.garbageFee = parseFloat(currentTracking.breakdown.garbageFee) || breakdown.garbageFee;
        if (currentTracking.breakdown.garbage !== undefined && currentTracking.breakdown.garbage > 0) breakdown.garbageFee = parseFloat(currentTracking.breakdown.garbage) || breakdown.garbageFee;
        if (currentTracking.breakdown.waterBill) breakdown.waterBill = parseFloat(currentTracking.breakdown.waterBill) || breakdown.waterBill;
        if (currentTracking.breakdown.water !== undefined && currentTracking.breakdown.water > 0) breakdown.waterBill = parseFloat(currentTracking.breakdown.water) || breakdown.waterBill;
        if (currentTracking.breakdown.electricityBill) breakdown.electricityBill = parseFloat(currentTracking.breakdown.electricityBill) || breakdown.electricityBill;
        if (currentTracking.breakdown.electricity !== undefined && currentTracking.breakdown.electricity > 0) breakdown.electricityBill = parseFloat(currentTracking.breakdown.electricity) || breakdown.electricityBill;
        if (currentTracking.breakdown.penalties !== undefined) breakdown.penalties = parseFloat(currentTracking.breakdown.penalties) || breakdown.penalties;
      }

      const totalExpected = breakdown.rent + breakdown.deposit + breakdown.garbageFee + breakdown.waterBill + breakdown.electricityBill + breakdown.penalties;
      const totalPaid = tenantPayments.reduce((sum, p) => sum + p.amount, 0);
      const remaining = Math.max(0, totalExpected - totalPaid);
      const overpaid = Math.max(0, totalPaid - totalExpected);
      
      let status = PAYMENT_STATUS.UNPAID;
      if (totalPaid >= totalExpected) status = PAYMENT_STATUS.PAID;
      else if (totalPaid > 0) status = PAYMENT_STATUS.PARTIAL;
      
      report.summary.totalTenants++;
      report.summary.totalExpected += totalExpected;
      report.summary.totalReceived += totalPaid;
      report.summary.totalRemaining += remaining;
      report.summary.totalOverpaid += overpaid;

      if (status === PAYMENT_STATUS.PAID) report.summary.paidInFull++;
      else if (status === PAYMENT_STATUS.PARTIAL) report.summary.partialPayment++;
      else report.summary.unpaid++;

      report.tenants.push({
        tenantId: tenant.id,
        name: tenant.name,
        unitName: unit.unitName || tenant.unitCode,
        propertyName: unitProperty?.propertyName || 'N/A',
        status,
        expected: totalExpected,
        paid: totalPaid,
        remaining,
        remainingAmount: remaining,
        arrears: remaining,
        phone: tenant.phone || tenant.phoneNumber || '',
        payments: tenantPayments,
        breakdown
      });
    }

    return report;
  }

  async getOverduePayments(agencyId, month, assignedProperties = []) {
    const report = await this.getMonthlyReport(agencyId, month, assignedProperties);
    const overdue = report.tenants.filter(t => t.status !== PAYMENT_STATUS.PAID && t.remaining > 0);
    return {
      month: report.month,
      count: overdue.length,
      tenants: overdue
    };
  }

  async sendReminders(agencyId, month, tenantIds, assignedProperties = []) {
    console.log(`[SMS] sendReminders called for agency: ${agencyId}, month: ${month}`);
    console.log(`[SMS] Received tenantIds from frontend:`, tenantIds);

    const overdueData = await this.getOverduePayments(agencyId, month, assignedProperties);
    console.log(`[SMS] Overdue tenants fetched: ${overdueData.tenants.length}`);

    const targetTenants = tenantIds && tenantIds.length > 0
      ? overdueData.tenants.filter(t => tenantIds.includes(t.tenantId))
      : overdueData.tenants;

    console.log(`[SMS] Filtered targetTenants: ${targetTenants.length}`);

    const results = { sent: 0, failed: 0, errors: [] };

    for (const overdueTenant of targetTenants) {
      console.log(`[SMS] Processing tenant: ${overdueTenant.name} (ID: ${overdueTenant.tenantId})`);
      try {
        // Fetch full tenant and property data for the SMS
        const tenantSnap = await getDoc(doc(db, 'tenants', overdueTenant.tenantId));
        if (!tenantSnap.exists()) continue;
        const tenant = tenantSnap.data();

        if (!tenant.phone) {
          results.failed++;
          results.errors.push(`${tenant.name}: No phone number`);
          continue;
        }

        const propertySnap = await getDoc(doc(db, 'properties', tenant.propertyId));
        const property = propertySnap.data() || {};
        
        // Use agency settings for Paybill
        const settings = await require('./settingsService').getSettings(agencyId);
        
        // Prepare tenant data structure for reminderService
        const tenantData = {
          ...tenant,
          arrears: overdueTenant.remaining || 0,
          propertyName: property.propertyName || overdueTenant.propertyName || 'your building'
        };

        const reminderService = require('./reminderService');
        const message = reminderService.generateReminderMessage(tenantData, settings);

        await smsService.sendSMS(tenant.phone, message, agencyId, 'system', overdueTenant.tenantId);
        results.sent++;
      } catch (err) {
        results.failed++;
        results.errors.push(`${overdueTenant.name}: ${err.message}`);
      }
    }

    return results;
  }
}

module.exports = new PaymentService();