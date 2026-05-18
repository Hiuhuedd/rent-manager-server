const { db } = require('../config/firebase');
const {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  limit,
} = require('firebase/firestore');

/**
 * Utility to convert Firebase timestamp or string to JS Date
 */
function toJsDate(value) {
  if (!value) return null;
  if (value.toDate) return value.toDate();
  if (typeof value === 'string') return new Date(value);
  return null;
}

class StatsService {
  /**
   * Get consolidated stats for a specific month
   * @param {string} agencyId 
   * @param {string[]|null} assignedProperties - List of property IDs to filter by (null for all)
   * @param {string} month - Format YYYY-MM
   */
  async getStats(agencyId, assignedProperties = null, month = null) {
    const startTime = Date.now();
    const now = new Date();
    
    // Default to current month if not provided
    const targetYear = month ? parseInt(month.split('-')[0]) : now.getFullYear();
    const targetMonthIndex = month ? parseInt(month.split('-')[1]) - 1 : now.getMonth();
    
    // Month boundaries
    const monthStart = new Date(targetYear, targetMonthIndex, 1);
    const monthEnd = new Date(targetYear, targetMonthIndex + 1, 0, 23, 59, 59);
    const monthKey = `${targetYear}-${String(targetMonthIndex + 1).padStart(2, '0')}`;
    const cutoffDate = monthEnd;

    console.log(`[STATS] Fetching stats for: ${monthKey} | Cutoff: ${cutoffDate.toISOString()}`);

    // === 1. Fetch ALL properties for the agency ===
    const propertiesQuery = query(
      collection(db, 'properties'),
      where('agencyId', '==', agencyId)
    );
    const fullPropertiesSnap = await getDocs(propertiesQuery);
    
    // Filter properties by createdAt (in memory to handle pending timestamps)
    let propertiesDocs = fullPropertiesSnap.docs.filter(doc => {
      const createdAt = toJsDate(doc.data().createdAt);
      return !createdAt || createdAt <= cutoffDate;
    });

    // Filter by assignedProperties if provided
    if (assignedProperties !== null) {
      propertiesDocs = propertiesDocs.filter(doc => 
        assignedProperties.includes(doc.id) || assignedProperties.includes(doc.data().propertyId)
      );
    }

    if (propertiesDocs.length === 0) {
      return {
        properties: 0,
        units: 0,
        occupied: 0,
        vacant: 0,
        revenue: 0,
        arrears: 0,
        expenses: 0,
        month: monthKey,
        timestamp: new Date().toISOString()
      };
    }

    // === 2. Fetch ALL units for the agency once ===
    const unitsQuery = query(
      collection(db, 'units'),
      where('agencyId', '==', agencyId)
    );
    const unitsSnap = await getDocs(unitsQuery);
    
    // Map units by propertyId
    const unitsByProperty = {};
    unitsSnap.docs.forEach(snap => {
      const data = snap.data();
      const pId = data.propertyId;
      if (!unitsByProperty[pId]) unitsByProperty[pId] = [];
      
      const createdAt = toJsDate(data.createdAt);
      if (!createdAt || createdAt <= cutoffDate) {
        unitsByProperty[pId].push(snap);
      }
    });

    // === 3. Fetch ALL tenants for the agency once ===
    const tenantsQuery = query(
      collection(db, 'tenants'),
      where('agencyId', '==', agencyId)
    );
    const tenantsSnap = await getDocs(tenantsQuery);
    const tenantMap = new Map();
    tenantsSnap.docs.forEach(snap => {
      tenantMap.set(snap.id, snap.data());
    });

    let totalUnits = 0;
    let occupiedUnits = 0;
    let vacantUnits = 0;
    let expectedMonthlyRevenue = 0;

    // === 4. Process each property ===
    for (const propDoc of propertiesDocs) {
      const propData = propDoc.data();
      const historicalUnits = unitsByProperty[propDoc.id] || [];
      totalUnits += historicalUnits.length;

      // Fetch utilities maps for this property
      let waterBillsMap = new Map();
      let elecBillsMap = new Map();

      // Water bills fetch
      const waterMeterType = propData.waterMeterSettings?.meterType || 'single';
      if (waterMeterType === 'individual') {
        try {
          const waterBillId = `${propDoc.id}_${monthKey}`;
          const waterBillSnap = await getDoc(doc(db, 'water_bills', waterBillId));
          if (waterBillSnap.exists()) {
            waterBillSnap.data().bills?.forEach(bill => {
              waterBillsMap.set(String(bill.unitId).trim(), parseFloat(bill.totalBill) || 0);
              if (bill.unitCode) waterBillsMap.set(String(bill.unitCode).trim(), parseFloat(bill.totalBill) || 0);
            });
          }
        } catch (e) {}
      }

      // Electricity bills fetch
      try {
        const elecBillId = `${propDoc.id}_${monthKey}`;
        const elecBillSnap = await getDoc(doc(db, 'electricity_bills', elecBillId));
        if (elecBillSnap.exists()) {
          elecBillSnap.data().bills?.forEach(bill => {
            elecBillsMap.set(String(bill.unitId).trim(), parseFloat(bill.totalBill) || 0);
          });
        }
      } catch (e) {}

      // Process units
      for (const unitSnap of historicalUnits) {
        const unitData = unitSnap.data();
        const tenantId = unitData.tenantId;
        const tenantData = tenantId ? tenantMap.get(tenantId) : null;

        const moveInDate = toJsDate(tenantData?.moveInDate);
        const moveOutDate = toJsDate(tenantData?.moveOutDate);

        const wasOccupiedInMonth = tenantId && 
          (!moveOutDate || moveOutDate >= monthStart) && 
          (!moveInDate || moveInDate < monthEnd);

        if (wasOccupiedInMonth) {
          occupiedUnits++;
          
          const rent = parseFloat(unitData.rentAmount) || 0;
          const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
          const deposit = parseFloat(unitData.depositAmount) || 0;
          
          let water = 0;
          if (waterMeterType === 'individual') {
            water = waterBillsMap.get(String(unitData.unitId).trim()) || waterBillsMap.get(unitSnap.id) || 0;
          } else {
            water = parseFloat(propData.waterMeterSettings?.fixedWaterBill) || parseFloat(unitData.utilityFees?.waterBill) || 0;
          }

          let electricity = elecBillsMap.get(String(unitData.unitId).trim()) || elecBillsMap.get(unitSnap.id) || parseFloat(unitData.utilityFees?.electricityBill) || 0;

          // DEPOSIT LOGIC: Use string comparison for robustness
          const movedInThisMonth = moveInDate && 
                                   moveInDate.getMonth() === targetMonthIndex && 
                                   moveInDate.getFullYear() === targetYear;
          
          expectedMonthlyRevenue += rent + garbage + water + electricity + (movedInThisMonth ? deposit : 0);
        } else {
          vacantUnits++;
        }
      }
    }

    // === 5. Arrears calculation ===
    // Use the already fetched tenantsSnap
    let tenantsForArrears = tenantsSnap.docs.filter(doc => {
      const createdAt = toJsDate(doc.data().createdAt);
      return !createdAt || createdAt <= cutoffDate;
    });

    if (assignedProperties !== null) {
      tenantsForArrears = tenantsForArrears.filter(doc => assignedProperties.includes(doc.data().propertyId));
    }

    let totalArrears = 0;
    tenantsForArrears.forEach(doc => {
      totalArrears += parseFloat(doc.data().financialSummary?.arrears || doc.data().arrears || 0);
    });

    // === 6. Expenses calculation ===
    const expensesQuery = query(
      collection(db, 'expenses'),
      where('agencyId', '==', agencyId),
      where('month', '==', monthKey)
    );
    const expensesSnap = await getDocs(expensesQuery);
    let totalExpenses = 0;
    expensesSnap.docs.forEach(doc => {
      const data = doc.data();
      if (assignedProperties === null || assignedProperties.includes(data.propertyId)) {
        totalExpenses += parseFloat(data.amount) || 0;
      }
    });

    return {
      properties: propertiesDocs.length,
      units: totalUnits,
      occupied: occupiedUnits,
      vacant: vacantUnits,
      revenue: expectedMonthlyRevenue,
      arrears: totalArrears,
      expenses: totalExpenses,
      month: monthKey,
      timestamp: new Date().toISOString(),
      queryDurationMs: Date.now() - startTime
    };
  }
}

module.exports = new StatsService();