// ============================================
// FILE: src/services/statsService.js
// ============================================
const { db } = require('../config/firebase');
const {
  collection,
  getDocs,
  doc,
  getDoc,
  query,
  where,
  orderBy,
  limit,
} = require('firebase/firestore');

/**
 * Safe conversion of any date field → JS Date
 */
const toJsDate = (field) => {
  if (!field) return null;
  if (typeof field.toDate === 'function') return field.toDate();
  if (field instanceof Date && !isNaN(field)) return field;
  if (typeof field === 'string') {
    const d = new Date(field);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
};

class StatsService {
  async getStats(month = null) {
    const startTime = Date.now();
    const now = new Date();

    // === Resolve target month ===
    const [yearStr, monthStr] = month ? month.split('-') : [];
    const targetYear = yearStr ? parseInt(yearStr) : now.getFullYear();
    const targetMonthIndex = monthStr ? parseInt(monthStr) - 1 : now.getMonth();

    const monthStart = new Date(targetYear, targetMonthIndex, 1);
    const monthEnd = new Date(targetYear, targetMonthIndex + 1, 1); // first day of next month

    // This is the cutoff: anything created AFTER this date didn't exist yet
    const cutoffDate = monthEnd;

    console.log(`[STATS] Historical stats for ${month || 'current'} → cutoff: ${cutoffDate.toISOString().slice(0,10)}`);

    let propertiesCount = 0;
    let totalUnits = 0;
    let occupiedUnits = 0;
    let vacantUnits = 0;
    let expectedMonthlyRevenue = 0;

    // === 1. Fetch only properties that existed by cutoffDate ===
    const propertiesQuery = query(
      collection(db, 'properties'),
      where('createdAt', '<=', cutoffDate)
    );
    const propertiesSnap = await getDocs(propertiesQuery);
    propertiesCount = propertiesSnap.size;

    if (propertiesCount === 0) {
      // Early return for brand new or future/past months with no data
      const stats = {
        properties: 0,
        units: 0,
        occupied: 0,
        vacant: 0,
        revenue: 0,
        arrears: 0,
        month: month || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`,
        timestamp: new Date().toISOString(),
        queryDurationMs: Date.now() - startTime,
      };
      console.log('[STATS] No properties existed in this period → empty stats');
      return stats;
    }

    // === 2. Process each historical property ===
    for (const propDoc of propertiesSnap.docs) {
      const propData = propDoc.data();

      // Fetch units that existed AND belonged to this property by cutoff date
      const unitIds = propData.propertyUnitIds || [];
      if (unitIds.length === 0) continue;

      const unitRefs = unitIds.map(id => doc(db, 'units', id));
      const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));

      // Filter units that existed by cutoffDate
      const historicalUnits = unitSnaps.filter(snap => {
        if (!snap.exists()) return false;
        const unitData = snap.data();
        const unitCreatedAt = toJsDate(unitData.createdAt);
        return unitCreatedAt && unitCreatedAt <= cutoffDate;
      });

      totalUnits += historicalUnits.length;

      // === Fetch tenants for potentially occupied units ===
      const tenantIdsToFetch = historicalUnits
        .map(snap => snap.data().tenantId)
        .filter(Boolean);

      const tenantRefs = tenantIdsToFetch.map(id => doc(db, 'tenants', id));
      const tenantSnaps = await Promise.all(tenantRefs.map(ref => getDoc(ref)));

      const tenantsMap = new Map();
      tenantSnaps.forEach(snap => {
        if (snap.exists()) tenantsMap.set(snap.id, snap.data());
      });

      // === Process each historical unit ===
      for (const unitSnap of historicalUnits) {
        const unitData = unitSnap.data();
        const tenantId = unitData.tenantId;
        const tenantData = tenantsMap.get(tenantId);

        const moveInDate = toJsDate(tenantData?.moveInDate);
        const moveOutDate = toJsDate(tenantData?.moveOutDate);

        const wasOccupiedInMonth =
          tenantId &&
          (!moveOutDate || moveOutDate >= monthStart) &&
          (!moveInDate || moveInDate < monthEnd);

        const rent = parseFloat(unitData.rentAmount) || 0;
        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unitData.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unitData.depositAmount) || 0;

        if (wasOccupiedInMonth) {
          occupiedUnits++;
          const movedInThisMonth = moveInDate && moveInDate >= monthStart && moveInDate < monthEnd;
          expectedMonthlyRevenue += rent + garbage + water + (movedInThisMonth ? deposit : 0);
        } else {
          vacantUnits++;
        }
      }
    }

    // === Arrears: only from tenants who existed by cutoffDate ===
    const tenantsQuery = query(
      collection(db, 'tenants'),
      where('createdAt', '<=', cutoffDate)
    );
    const tenantsSnap = await getDocs(tenantsQuery);
    let totalArrears = 0;
    tenantsSnap.forEach(doc => {
      totalArrears += parseFloat(doc.data().arrears) || 0;
    });

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

    console.log(`[SUCCESS] Historical stats for ${stats.month}:`, stats);
    return stats;
  }
}

module.exports = new StatsService();