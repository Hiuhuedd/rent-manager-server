// ============================================
// FILE: src/services/propertyService.js
// ============================================
const { db } = require('../config/firebase');
const {
  collection,
  getDocs,
  getDoc,
  doc,
  writeBatch,
  setDoc,
  serverTimestamp, // ← Important: for accurate createdAt
} = require('firebase/firestore');

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
          unitName: data.unitName || data.unitId, // Return display name
          category: data.category,
          rentAmount: data.rentAmount,
          depositAmount: data.depositAmount || 0, // Return deposit
          utilityFees: {
            garbageFee: data.utilityFees?.garbageFee || 0,
            waterBill: data.utilityFees?.waterBill || 0,
          },
          waterMeterReading: data.waterMeterReading || 0,
          waterMeterReadings: data.waterMeterReadings || [],
          isVacant: data.isVacant,
          tenantId: data.tenantId || null,
        };
      });

    // For properties with individual meters, exclude water bills from base revenue
    // as they are calculated dynamically each month
    const waterMeterType = propertyData.waterMeterSettings?.meterType || 'single';
    const includeWaterInRevenue = waterMeterType === 'single';

    const recalculatedRevenue = units.reduce((sum, unit) => {
      // Revenue calculation includes recurring monthly fees, not deposit
      const waterBill = includeWaterInRevenue ? unit.utilityFees.waterBill : 0;
      return sum + unit.rentAmount + unit.utilityFees.garbageFee + waterBill;
    }, 0);

    const vacantCount = units.filter(u => u.isVacant).length;

    return {
      propertyId: propertyData.propertyId,
      propertyName: propertyData.propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: recalculatedRevenue,
      propertyVacantUnits: vacantCount,
      propertyOccupiedUnits: units.length - vacantCount,
      caretaker: propertyData.caretaker || {},
      owner: propertyData.owner || {},
      waterMeterSettings: propertyData.waterMeterSettings || { meterType: 'single', costPerUnit: 95 },
      electricitySettings: propertyData.electricitySettings || {},
      agencyCommission: propertyData.agencyCommission !== undefined ? propertyData.agencyCommission : 8,
      createdAt: propertyData.createdAt?.toDate?.() || null,
      units,
      queryDurationMs: Date.now() - start,
    };
  }

  /**
   * Create a new property + units with proper createdAt timestamps
   */
  async createProperty({ propertyName, units, caretaker, owner, waterMeterSettings, electricitySettings }) {
    const start = Date.now();
    const batch = writeBatch(db);
    const propertyRef = doc(collection(db, 'properties'));
    const propertyId = propertyRef.id;
    const propertyUnitIds = [];

    let totalRevenue = 0;

    const now = serverTimestamp(); // ← Firestore server time (accurate & secure)

    units.forEach((unit) => {
      const unitId = unit.unitId;
      const unitRef = doc(db, 'units', unitId);
      propertyUnitIds.push(unitId);

      const rent = parseFloat(unit.rentAmount) || 0;
      const deposit = parseFloat(unit.depositAmount) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;

      // Ensure creation captures unitName if provided
      const unitName = unit.unitName || unit.unitId;

      const unitTotal = rent + garbage + water; // Revenue excludes deposit
      totalRevenue += unitTotal;

      const unitData = {
        unitId,
        unitName, // Added
        propertyId,
        isVacant: true,
        category: unit.category || 'Standard',
        rentAmount: rent,
        depositAmount: deposit,
        utilityFees: { garbageFee: garbage, waterBill: water },
        createdAt: now,
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
      agencyCommission: 8, // Default 8% for new properties
      createdAt: now,
    };

    // Add caretaker data if provided
    if (caretaker && (caretaker.name || caretaker.phone)) {
      propertyData.caretaker = {
        name: caretaker.name || '',
        phone: caretaker.phone || '',
      };
    }

    // Add owner data if provided
    if (owner && owner.name) {
      propertyData.owner = {
        name: owner.name || '',
      };
    }

    // Add water meter settings if provided
    if (waterMeterSettings && waterMeterSettings.meterType) {
      propertyData.waterMeterSettings = {
        meterType: waterMeterSettings.meterType,
        costPerUnit: waterMeterSettings.meterType === 'individual' ? (waterMeterSettings.costPerUnit || 0) : null,
      };
    }

    // Add electricity settings if provided
    if (electricitySettings) {
      propertyData.electricitySettings = electricitySettings;
    }

    batch.set(propertyRef, propertyData);
    await batch.commit();

    console.log(`[SUCCESS] Property created: ${propertyName} | ${units.length} units | ID: ${propertyId}`);

    return {
      propertyId,
      propertyName,
      totalRevenue,
      durationMs: Date.now() - start,
    };
  }

  async updateProperty(id, { propertyName, units, caretaker, owner, waterMeterSettings, electricitySettings, agencyCommission }) {
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
      const { unitId, unitName, rentAmount, depositAmount, utilityFees = {}, isVacant, category } = unit;

      const rent = parseFloat(rentAmount) || 0;
      const deposit = parseFloat(depositAmount) || 0;
      const garbage = parseFloat(utilityFees.garbageFee) || 0;
      const water = parseFloat(utilityFees.waterBill) || 0;

      const unitTotal = rent + garbage + water;
      totalRevenue += unitTotal;

      if (isVacant === true) vacantCount++;

      const unitRef = doc(db, 'units', unitId);
      batch.set(
        unitRef,
        {
          unitName: unitName || unitId, // Update unitName
          rentAmount: rent,
          depositAmount: deposit, // Update deposit
          utilityFees: { garbageFee: garbage, waterBill: water },
          isVacant: !!isVacant,
          category: category || 'Standard',
        },
        { merge: true }
      );
    }

    const propertyUpdateData = {
      propertyName,
      propertyRevenueTotal: totalRevenue,
      propertyOccupiedUnits: units.length - vacantCount,
      agencyCommission: agencyCommission !== undefined ? parseFloat(agencyCommission) : (propertySnap.data().agencyCommission !== undefined ? propertySnap.data().agencyCommission : 8),
      updatedAt: serverTimestamp(),
    };

    // Add caretaker data if provided
    if (caretaker && (caretaker.name || caretaker.phone)) {
      propertyUpdateData.caretaker = {
        name: caretaker.name || '',
        phone: caretaker.phone || '',
      };
    }

    // Add owner data if provided
    if (owner && owner.name) {
      propertyUpdateData.owner = {
        name: owner.name || '',
      };
    }

    // Add water meter settings if provided
    if (waterMeterSettings && waterMeterSettings.meterType) {
      propertyUpdateData.waterMeterSettings = {
        meterType: waterMeterSettings.meterType,
        costPerUnit: waterMeterSettings.meterType === 'individual' ? (waterMeterSettings.costPerUnit || 0) : null,
      };
    }

    // Add electricity settings if provided
    if (electricitySettings) {
      propertyUpdateData.electricitySettings = electricitySettings;
    }

    batch.set(propertyRef, propertyUpdateData, { merge: true });

    await batch.commit();

    return {
      propertyId: id,
      propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: totalRevenue,
      durationMs: Date.now() - start,
    };
  }

  async updateUnit(propertyId, unitId, data) {
    const start = Date.now();
    const unitRef = doc(db, 'units', unitId);
    const unitSnap = await getDoc(unitRef);

    if (!unitSnap.exists()) {
      throw new Error('Unit not found');
    }

    // Update the unit
    const rent = parseFloat(data.rentAmount) || 0;
    const deposit = parseFloat(data.depositAmount) || 0;
    const garbage = parseFloat(data.utilityFees?.garbageFee) || 0;
    const water = parseFloat(data.utilityFees?.waterBill) || 0;
    const waterMeterReading = (data.waterMeterReading !== undefined && data.waterMeterReading !== null && data.waterMeterReading !== '') ? parseFloat(data.waterMeterReading) : null;

    // Build update object
    const updateData = {
      unitName: data.unitName || unitId,
      rentAmount: rent,
      depositAmount: deposit,
      utilityFees: { garbageFee: garbage, waterBill: water },
      isVacant: data.isVacant !== undefined ? !!data.isVacant : unitSnap.data().isVacant,
      category: data.category || unitSnap.data().category,
      updatedAt: serverTimestamp(),
    };

    // Handle water meter reading if provided
    if (waterMeterReading !== null) {
      updateData.waterMeterReading = waterMeterReading;

      // Add to water meter readings history
      const now = new Date();
      const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const recordedAtTimestamp = now.getTime(); // Use milliseconds timestamp instead of serverTimestamp

      const existingReadings = unitSnap.data().waterMeterReadings || [];

      // Update or add reading for current month
      const readingIndex = existingReadings.findIndex(r => r.month === monthYear);
      if (readingIndex >= 0) {
        existingReadings[readingIndex] = {
          month: monthYear,
          units: waterMeterReading,
          recordedAt: recordedAtTimestamp,
        };
      } else {
        existingReadings.push({
          month: monthYear,
          units: waterMeterReading,
          recordedAt: recordedAtTimestamp,
        });
      }

      updateData.waterMeterReadings = existingReadings;
    }

    await setDoc(unitRef, updateData, { merge: true });

    // Recalculate property stats
    const propertyData = await this.getPropertyById(propertyId);
    if (propertyData) {
      const propertyRef = doc(db, 'properties', propertyId);
      await setDoc(propertyRef, {
        propertyRevenueTotal: propertyData.propertyRevenueTotal,
        propertyVacantUnits: propertyData.propertyVacantUnits,
        propertyOccupiedUnits: propertyData.propertyOccupiedUnits,
        updatedAt: serverTimestamp(),
      }, { merge: true });
    }

    return {
      success: true,
      unitId,
      durationMs: Date.now() - start,
    };
  }

  async deleteProperty(propertyId) {
    const start = Date.now();

    // 1. Fetch property details to check occupancy
    const property = await this.getPropertyById(propertyId);
    if (!property) {
      throw new Error('Property not found');
    }

    // 2. Check for active tenants
    const hasActiveTenants = property.units.some(unit => !unit.isVacant);
    if (hasActiveTenants) {
      throw new Error('Cannot delete property with active tenants. Please remove tenants first.');
    }

    // 3. Batch delete units and property
    const batch = writeBatch(db);

    // Delete all units
    property.units.forEach(unit => {
      const unitRef = doc(db, 'units', unit.unitId);
      batch.delete(unitRef);
    });

    // Delete property document
    const propertyRef = doc(db, 'properties', propertyId);
    batch.delete(propertyRef);

    await batch.commit();

    console.log(`[SUCCESS] Property deleted: ${propertyId} | Duration: ${Date.now() - start}ms`);
    return { success: true };
  }

}

module.exports = new PropertyService();