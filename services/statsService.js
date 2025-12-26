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
  serverTimestamp,
} = require('firebase/firestore');

/**
 * Safe conversion: any date field → JS Date
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

    // === Properly resolve target month (this was the bug!) ===
    let targetYear, targetMonthIndex;

    if (month && typeof month === 'string' && month.includes('-')) {
      const parts = month.split('-');
      targetYear = parseInt(parts[0], 10);
      targetMonthIndex = parseInt(parts[1], 10) - 1; // JS months are 0-indexed
    } else {
      // Default: current month
      targetYear = now.getFullYear();
      targetMonthIndex = now.getMonth();
    }

    const monthStart = new Date(targetYear, targetMonthIndex, 1);
    const monthEnd = new Date(targetYear, targetMonthIndex + 1, 1);
    const cutoffDate = monthEnd; // Anything created AFTER this didn't exist yet

    const monthKey = `${targetYear}-${String(targetMonthIndex + 1).padStart(2, '0')}`;
    console.log(`[STATS] Fetching stats for: ${monthKey} | Cutoff: ${cutoffDate.toISOString().slice(0, 10)}`);

    let propertiesCount = 0;
    let totalUnits = 0;
    let occupiedUnits = 0;
    let vacantUnits = 0;
    let expectedMonthlyRevenue = 0;

    // === 1. Properties that existed by cutoff date ===
    const propertiesQuery = query(
      collection(db, 'properties'),
      where('createdAt', '<=', cutoffDate)
    );
    const propertiesSnap = await getDocs(propertiesQuery);
    propertiesCount = propertiesSnap.size;

    if (propertiesCount === 0) {
      return {
        properties: 0,
        units: 0,
        occupied: 0,
        vacant: 0,
        revenue: 0,
        arrears: 0,
        month: monthKey,
        timestamp: new Date().toISOString(),
        queryDurationMs: Date.now() - startTime,
      };
    }

    // === 2. Process each historical property ===
    for (const propDoc of propertiesSnap.docs) {
      const propData = propDoc.data();
      const unitIds = propData.propertyUnitIds || [];

      if (unitIds.length === 0) continue;

      const unitRefs = unitIds.map(id => doc(db, 'units', id));
      const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));

      // Only units that existed by cutoffDate
      const historicalUnits = unitSnaps.filter(snap => {
        if (!snap.exists()) return false;
        const createdAt = toJsDate(snap.data().createdAt);
        return createdAt && createdAt <= cutoffDate;
      });

      totalUnits += historicalUnits.length;

      // === Fetch tenants for occupied units ===
      const tenantIds = historicalUnits
        .map(snap => snap.data().tenantId)
        .filter(Boolean);

      const tenantMap = new Map();
      if (tenantIds.length > 0) {
        const tenantRefs = tenantIds.map(id => doc(db, 'tenants', id));
        const tenantSnaps = await Promise.all(tenantRefs.map(ref => getDoc(ref)));
        tenantSnaps.forEach(snap => {
          if (snap.exists()) tenantMap.set(snap.id, snap.data());
        });
      }

      // === Fetch water bills for this property if it has individual meters ===
      const waterMeterType = propData.waterMeterSettings?.meterType || 'single';
      let waterBillsMap = new Map();

      if (waterMeterType === 'individual') {
        try {
          const waterBillId = `${propDoc.id}_${monthKey}`;
          const waterBillRef = doc(db, 'water_bills', waterBillId);
          const waterBillSnap = await getDoc(waterBillRef);

          console.log(`[STATS] Checking water bill document: ${waterBillId} | Found: ${waterBillSnap.exists()}`);

          if (waterBillSnap.exists()) {
            const waterBillData = waterBillSnap.data();
            console.log(`[STATS] Water bill data for ${waterBillId}:`, JSON.stringify(waterBillData.bills || []));

            waterBillData.bills?.forEach(bill => {
              const uid = String(bill.unitId).trim();
              const ucode = String(bill.unitCode || '').trim();
              const amount = parseFloat(bill.totalBill) || 0;
              waterBillsMap.set(uid, amount);
              if (ucode) waterBillsMap.set(ucode, amount);
              console.log(`[STATS] Mapped water bill - Unit: ${uid}/${ucode}, Amount: ${amount}`);
            });
          }
        } catch (waterBillError) {
          console.warn(`[STATS] Failed to fetch water bills:`, waterBillError.message);
        }
      }

      // === Process each unit ===
      for (const unitSnap of historicalUnits) {
        const unitData = unitSnap.data();
        const tenantData = tenantMap.get(unitData.tenantId);

        const moveInDate = toJsDate(tenantData?.moveInDate);
        const moveOutDate = toJsDate(tenantData?.moveOutDate);

        const wasOccupiedInMonth =
          unitData.tenantId &&
          (!moveOutDate || moveOutDate >= monthStart) &&
          (!moveInDate || moveInDate < monthEnd);

        const rent = parseFloat(unitData.rentAmount) || 0;
        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
        let water = parseFloat(unitData.utilityFees?.waterBill) || 0;

        // For properties with individual meters, use water bill from collection
        let waterRevenue = 0;

        if (waterMeterType === 'individual') {
          const unitId = String(unitData.unitId || '').trim();
          const docId = String(unitSnap.id).trim();

          if (unitId && waterBillsMap.has(unitId)) {
            waterRevenue = waterBillsMap.get(unitId);
          } else if (waterBillsMap.has(docId)) {
            waterRevenue = waterBillsMap.get(docId);
          } else {
            console.log(`[STATS] No water bill match for unit ${unitId} (doc: ${docId}) in ${Array.from(waterBillsMap.keys())}`);
          }
          water = waterRevenue;
        } else {
          const fixedWaterBill = parseFloat(propData.waterMeterSettings?.fixedWaterBill);
          waterRevenue = !isNaN(fixedWaterBill) ? fixedWaterBill : water;
        }

        if (wasOccupiedInMonth) {
          occupiedUnits++;
          const movedInThisMonth = moveInDate && moveInDate >= monthStart && moveInDate < monthEnd;
          const unitTotal = rent + garbage + waterRevenue + (movedInThisMonth ? (parseFloat(unitData.depositAmount) || 0) : 0);
          expectedMonthlyRevenue += unitTotal;
          console.log(`[STATS] Unit ${unitData.unitId} expected: ${unitTotal} (Rent: ${rent}, G: ${garbage}, W: ${waterRevenue})`);
        } else {
          vacantUnits++;
        }
      }
    }

    // === Arrears from tenants who existed by cutoff date ===
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
      month: monthKey,
      timestamp: new Date().toISOString(),
      queryDurationMs: Date.now() - startTime,
    };

    console.log(`[SUCCESS] Stats for ${stats.month}:`, stats);
    return stats;
  }
}

module.exports = new StatsService();