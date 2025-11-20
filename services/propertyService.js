// ============================================
// FILE: src/services/propertyService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs, getDoc, doc, writeBatch, setDoc } = require('firebase/firestore');

class PropertyService {
  async getAllProperties() {
    const snapshot = await getDocs(collection(db, 'properties'));
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  async getPropertyById(id) {
    const start = Date.now();
    const propertyRef = doc(db, 'properties', id);
    const propertySnap = await getDoc(propertyRef);

    if (!propertySnap.exists()) {
      return null;
    }

    const propertyData = propertySnap.data();
    const unitIds = propertyData.propertyUnitIds || [];
    
    const unitRefs = unitIds.map(uid => doc(db, 'units', uid));
    const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));

    const units = unitSnaps
      .filter(snap => snap.exists())
      .map(snap => {
        const data = snap.data();
        return {
          unitId: data.unitId,
          category: data.category,
          rentAmount: data.rentAmount,
          utilityFees: {
            garbageFee: data.utilityFees?.garbageFee || 0,
            waterBill: data.utilityFees?.waterBill || 0,
          },
          isVacant: data.isVacant,
          tenantId: data.tenantId || null,
        };
      });

    const recalculatedRevenue = units.reduce((sum, unit) => {
      return sum + unit.rentAmount + unit.utilityFees.garbageFee + unit.utilityFees.waterBill;
    }, 0);

    const vacantCount = units.filter(u => u.isVacant).length;

    return {
      propertyId: propertyData.propertyId,
      propertyName: propertyData.propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: recalculatedRevenue,
      propertyVacantUnits: vacantCount,
      propertyOccupiedUnits: units.length - vacantCount,
      createdAt: propertyData.createdAt?.toDate?.() || null,
      units,
      queryDurationMs: Date.now() - start,
    };
  }

  async createProperty({ propertyName, units }) {
    const start = Date.now();
    const batch = writeBatch(db);
    const propertyRef = doc(collection(db, 'properties'));
    const propertyId = propertyRef.id;
    const propertyUnitIds = [];

    let totalRevenue = 0;

    units.forEach((unit) => {
      const unitId = unit.unitId;
      const unitRef = doc(db, 'units', unitId);
      propertyUnitIds.push(unitId);

      const rent = parseFloat(unit.rentAmount) || 0;
      const deposit = parseFloat(unit.depositAmount) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;

      const unitTotal = rent + garbage + water + deposit;
      totalRevenue += unitTotal;

      const unitData = {
        unitId,
        propertyId,
        isVacant: true,
        category: unit.category || 'Standard',
        rentAmount: rent,
        depositAmount: deposit,
        utilityFees: { garbageFee: garbage, waterBill: water },
      };

      batch.set(unitRef, unitData);
    });

    const propertyData = {
      propertyId,
      propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: totalRevenue,
      propertyUnitIds,
      propertyVacantUnits: units.length,
    };

    batch.set(propertyRef, propertyData);
    await batch.commit();

    return {
      propertyId,
      totalRevenue,
      durationMs: Date.now() - start,
    };
  }

  async updateProperty(id, { propertyName, units }) {
    const start = Date.now();
    const propertyRef = doc(db, 'properties', id);
    const propertySnap = await getDoc(propertyRef);

    if (!propertySnap.exists()) {
      return null;
    }

    const batch = writeBatch(db);
    let totalRevenue = 0;
    let vacantCount = 0;

    for (const unit of units) {
      const { unitId, rentAmount, utilityFees = {}, isVacant, category } = unit;

      const rent = parseFloat(rentAmount) || 0;
      const garbage = parseFloat(utilityFees.garbageFee) || 0;
      const water = parseFloat(utilityFees.waterBill) || 0;

      const unitTotal = rent + garbage + water;
      totalRevenue += unitTotal;

      if (isVacant === true) vacantCount++;

      const unitRef = doc(db, 'units', unitId);
      batch.set(
        unitRef,
        {
          rentAmount: rent,
          utilityFees: { garbageFee: garbage, waterBill: water },
          isVacant: !!isVacant,
          category: category || 'Standard',
        },
        { merge: true }
      );
    }

    batch.set(
      propertyRef,
      {
        propertyName,
        propertyRevenueTotal: totalRevenue,
        propertyVacantUnits: vacantCount,
        propertyOccupiedUnits: units.length - vacantCount,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    await batch.commit();

    return {
      propertyId: id,
      propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: totalRevenue,
      durationMs: Date.now() - start,
    };
  }
}

module.exports = new PropertyService();