// ============================================
// FILE: src/services/statsService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs, doc, getDoc } = require('firebase/firestore');

/**
 * Safely converts any Firestore date field to a JavaScript Date
 * Supports: Firestore Timestamp, JS Date, ISO string, or null/undefined
 */
const toJsDate = (field) => {
  if (!field) return null;

  // Firestore Timestamp
  if (typeof field.toDate === 'function') {
    return field.toDate();
  }

  // Already a valid Date
  if (field instanceof Date && !isNaN(field)) {
    return field;
  }

  // String date (e.g., "2025-04-15" or ISO)
  if (typeof field === 'string') {
    const parsed = new Date(field);
    return isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

class StatsService {
  /**
   * Get portfolio stats for a specific month (YYYY-MM)
   * If no month is provided → uses current month
   */
  async getStats(month = null) {
    const startTime = Date.now();
    console.log(`[STATS] Fetching stats for month: ${month || 'current'}`);

    // === Resolve target month ===
    const now = new Date();
    const [targetYear, targetMonth] = month
      ? month.split('-').map(Number)
      : [now.getFullYear(), now.getMonth() + 1];

    const year = targetYear;
    const monthIndex = targetMonth - 1; // JS months are 0-indexed

    const monthStart = new Date(year, monthIndex, 1);        // e.g., 2025-10-01
    const monthEnd = new Date(year, monthIndex + 1, 1);      // 2025-11-01

    console.log(`[STATS] Period: ${monthStart.toISOString().slice(0,10)} → ${monthEnd.toISOString().slice(0,10)}`);

    let totalUnits = 0;
    let occupiedUnits = 0;
    let vacantUnits = 0;
    let expectedMonthlyRevenue = 0;

    // === Fetch all properties ===
    const propertiesSnap = await getDocs(collection(db, 'properties'));
    const propertiesCount = propertiesSnap.size;

    for (const [idx, propDoc] of propertiesSnap.docs.entries()) {
      const propData = propDoc.data();
      const unitIds = propData.propertyUnitIds || [];

      if (unitIds.length === 0) continue;

      // === Fetch all units for this property ===
      const unitRefs = unitIds.map(id => doc(db, 'units', id));
      const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));
      const validUnits = unitSnaps.filter(snap => snap.exists());

      totalUnits += validUnits.length;

      // === Collect tenant IDs for occupied units ===
      const tenantIdsToFetch = validUnits
        .filter(snap => !snap.data().isVacant && snap.data().tenantId)
        .map(snap => snap.data().tenantId)
        .filter(Boolean);

      // === Batch fetch tenants ===
      const tenantRefs = tenantIdsToFetch.map(id => doc(db, 'tenants', id));
      const tenantSnaps = await Promise.all(tenantRefs.map(ref => getDoc(ref)));

      const tenantsMap = new Map();
      tenantSnaps.forEach(snap => {
        if (snap.exists()) {
          tenantsMap.set(snap.id, snap.data());
        }
      });

      // === Process each unit ===
      for (const unitSnap of validUnits) {
        const unitData = unitSnap.data();
        const tenantId = unitData.tenantId;
        const tenantData = tenantsMap.get(tenantId);

        const moveInDate = toJsDate(tenantData?.moveInDate);
        const moveOutDate = toJsDate(tenantData?.moveOutDate);

        // Was this unit occupied at any point during the target month?
        const wasOccupiedInMonth =
          tenantId &&
          (!moveOutDate || moveOutDate >= monthStart) &&   // hasn't moved out before month start
          (!moveInDate || moveInDate < monthEnd);         // moved in before month ends

        const rent = parseFloat(unitData.rentAmount) || 0;
        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unitData.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unitData.depositAmount) || 0;

        if (wasOccupiedInMonth) {
          occupiedUnits++;

          // Deposit only counts if tenant moved in during this month
          const movedInThisMonth = moveInDate && moveInDate >= monthStart && moveInDate < monthEnd;
          const monthlyTotal = rent + garbage + water + (movedInThisMonth ? deposit : 0);

          expectedMonthlyRevenue += monthlyTotal;

          console.log(`   [UNIT] Occupied → +${monthlyTotal} (${movedInThisMonth ? '+deposit' : 'no deposit'})`);
        } else {
          vacantUnits++;
          console.log(`   [UNIT] Vacant in ${month || 'current month'}`);
        }
      }
    }

    // === Total arrears (still global, not monthly) ===
    const tenantsSnap = await getDocs(collection(db, 'tenants'));
    let totalArrears = 0;
    tenantsSnap.forEach(doc => {
      totalArrears += parseFloat(doc.data().arrears) || 0;
    });

    // === Final stats object ===
    const stats = {
      properties: propertiesCount,
      units: totalUnits,
      occupied: occupiedUnits,
      vacant: vacantUnits,
      revenue: Number(expectedMonthlyRevenue.toFixed(2)),
      arrears: Number(totalArrears.toFixed(2)),
      month: month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
      timestamp: new Date().toISOString(),
      queryDurationMs: Date.now() - startTime,
    };

    console.log(`[SUCCESS] Stats ready for ${stats.month} | Revenue: ${stats.revenue} | Duration: ${stats.queryDurationMs}ms`);
    return stats;
  }
}

module.exports = new StatsService();