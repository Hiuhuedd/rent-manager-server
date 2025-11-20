// ============================================
// FILE: src/services/statsService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs } = require('firebase/firestore');
const { isMovedInThisMonth } = require('../utils/dateHelper');

class StatsService {
  async getStats() {
    const startTime = Date.now();
    console.log('[INFO] Fetching stats at:', new Date().toISOString());

    const propertiesSnap = await getDocs(collection(db, 'properties'));
    const propertiesCount = propertiesSnap.size;
    console.log(`[SUCCESS] Found ${propertiesCount} properties`);

    let totalUnits = 0;
    let expectedMonthlyRevenue = 0;
    let occupiedUnits = 0;
    let vacantUnits = 0;

    for (const [idx, propDoc] of propertiesSnap.docs.entries()) {
      const propData = propDoc.data();
      console.log(`[STEP ${idx + 1}] Property: ${propData.propertyName || propDoc.id}`);

      const unitIds = propData.propertyUnitIds || [];

      if (unitIds.length === 0) {
        console.log(`   → No units listed`);
        continue;
      }

      const unitRefs = unitIds.map(id => doc(db, 'units', id));
      const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));
      const validUnits = unitSnaps.filter(snap => snap.exists());

      totalUnits += validUnits.length;

      const occupiedUnitTenantIds = validUnits
        .filter(snap => !snap.data().isVacant && snap.data().tenantId)
        .map(snap => snap.data().tenantId);

      const tenantRefs = occupiedUnitTenantIds.map(id => doc(db, 'tenants', id));
      const tenantSnaps = await Promise.all(tenantRefs.map(ref => getDoc(ref)));
      const tenantsMap = new Map();
      
      tenantSnaps.forEach(snap => {
        if (snap.exists()) {
          tenantsMap.set(snap.id, snap.data());
        }
      });

      validUnits.forEach((unitSnap, uIdx) => {
        const unitData = unitSnap.data();

        const rent = parseFloat(unitData.rentAmount) || 0;
        const deposit = parseFloat(unitData.depositAmount) || 0;
        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unitData.utilityFees?.waterBill) || 0;

        if (unitData.isVacant === false) {
          occupiedUnits++;
          
          const tenantData = tenantsMap.get(unitData.tenantId);
          const isNewTenant = tenantData && isMovedInThisMonth(tenantData.moveInDate);
          
          const unitMonthlyTotal = rent + garbage + water + (isNewTenant ? deposit : 0);
          expectedMonthlyRevenue += unitMonthlyTotal;
          
          console.log(`   [UNIT ${uIdx + 1}] Occupied | Rent: ${rent} | Deposit: ${isNewTenant ? deposit : 0} | Total: ${unitMonthlyTotal}`);
        } else {
          vacantUnits++;
          console.log(`   [UNIT ${uIdx + 1}] Vacant`);
        }
      });
    }

    // Fetch tenant arrears
    console.log('[STEP] Fetching tenant arrears...');
    const tenantsSnap = await getDocs(collection(db, 'tenants'));
    let totalArrears = 0;

    tenantsSnap.docs.forEach((tenantDoc) => {
      const tenantData = tenantDoc.data();
      const arrears = parseFloat(tenantData.arrears) || 0;
      totalArrears += arrears;
    });

    const stats = {
      properties: propertiesCount,
      units: totalUnits,
      revenue: expectedMonthlyRevenue,
      arrears: totalArrears,
      occupied: occupiedUnits,
      vacant: vacantUnits,
      timestamp: new Date().toISOString(),
      queryDurationMs: Date.now() - startTime,
    };

    console.log('[SUCCESS] Stats compiled:', JSON.stringify(stats, null, 2));
    return stats;
  }
}

module.exports = new StatsService();