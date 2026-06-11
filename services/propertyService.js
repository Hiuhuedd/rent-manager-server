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
  serverTimestamp,
  query,
  where,
  arrayUnion,
} = require('firebase/firestore');

class PropertyService {
  async getAllProperties(agencyId, assignedProperties = [], userUid = null) {
    let properties = [];

    if (userUid && assignedProperties) {
      // Subagent Case: Merge assigned properties and created properties
      // Query 1: Assigned properties
      let assignedSnap = { docs: [] };
      if (assignedProperties.length > 0) {
        const q1 = query(
          collection(db, 'properties'),
          where('agencyId', '==', agencyId),
          where('propertyId', 'in', assignedProperties)
        );
        assignedSnap = await getDocs(q1);
      }

      // Query 2: Created properties
      const q2 = query(
        collection(db, 'properties'),
        where('agencyId', '==', agencyId),
        where('createdBy', '==', userUid)
      );
      const createdSnap = await getDocs(q2);

      // Merge and deduplicate
      const propMap = new Map();
      assignedSnap.docs.forEach(doc => propMap.set(doc.id, { id: doc.id, ...doc.data() }));
      createdSnap.docs.forEach(doc => propMap.set(doc.id, { id: doc.id, ...doc.data() }));
      properties = Array.from(propMap.values());
    } else {
      // Admin Case: All properties for agency
      const q = query(
        collection(db, 'properties'),
        where('agencyId', '==', agencyId)
      );
      const snapshot = await getDocs(q);
      properties = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    return properties;
  }

  async getPropertyById(id, agencyId) {
    const start = Date.now();
    const propertyRef = doc(db, 'properties', id);
    const propertySnap = await getDoc(propertyRef);

    if (!propertySnap.exists()) {
      return null;
    }

    const propertyData = propertySnap.data();

    // Security Check: Ensure property belongs to agency
    if (agencyId && propertyData.agencyId !== agencyId) {
      throw new Error('Unauthorized: Property does not belong to your agency');
    }
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
            electricityBill: data.utilityFees?.electricityBill || 0,
          },
          waterMeterReading: data.waterMeterReading || 0,
          waterMeterReadings: data.waterMeterReadings || [],
          isVacant: data.isVacant,
          tenantId: data.tenantId || null,
        };
      });

    const waterMeterType = propertyData.waterMeterSettings?.meterType || 'single';
    const includeWaterInRevenue = waterMeterType === 'single';

    // Fetch tenant names for display
    const tenantsWithNames = await Promise.all(units.map(async (u) => {
      if (u.tenantId) {
        const tSnap = await getDoc(doc(db, 'tenants', u.tenantId));
        if (tSnap.exists()) {
          return { ...u, tenantName: tSnap.data().name };
        }
      }
      return { ...u, tenantName: null };
    }));

    const recalculatedRevenue = tenantsWithNames.reduce((sum, unit) => {
      if (!unit.tenantId) return sum; // Only count occupied units for expected revenue
      const waterBill = includeWaterInRevenue ? (unit.utilityFees?.waterBill || 0) : 0;
      const electricityBill = unit.utilityFees?.electricityBill || 0;
      return sum + (unit.rentAmount || 0) + (unit.utilityFees?.garbageFee || 0) + waterBill + electricityBill;
    }, 0);

    const occupiedCount = tenantsWithNames.filter(u => u.tenantId).length;
    const vacantCount = tenantsWithNames.length - occupiedCount;

    return {
      propertyId: propertyData.propertyId,
      propertyName: propertyData.propertyName,
      address: propertyData.address || propertyData.location || '',
      propertyUnitsTotal: tenantsWithNames.length,
      propertyRevenueTotal: recalculatedRevenue,
      expectedMonthlyRevenue: recalculatedRevenue, // For frontend compatibility
      propertyVacantUnits: vacantCount,
      propertyOccupiedUnits: occupiedCount,
      caretaker: propertyData.caretaker || {},
      owner: propertyData.owner || {},
      waterMeterSettings: propertyData.waterMeterSettings || { meterType: 'single', costPerUnit: 95 },
      electricitySettings: propertyData.electricitySettings || {},
      agencyCommission: propertyData.agencyCommission !== undefined ? propertyData.agencyCommission : 8,
      createdAt: propertyData.createdAt?.toDate?.() || null,
      createdBy: propertyData.createdBy || null,
      units: tenantsWithNames,
      queryDurationMs: Date.now() - start,
    };
  }

  /**
   * Create a new property + units with proper createdAt timestamps
   */
  async createProperty(agencyId, userUid, { propertyName, address, units, caretaker, owner, agencyCommission, waterMeterSettings, electricitySettings }) {
    const start = Date.now();
    
    // 1. Fetch Subscription Limits
    const agencyRef = doc(db, 'agencies', agencyId);
    const agencySnap = await getDoc(agencyRef);
    const agencyData = agencySnap.exists() ? agencySnap.data() : {};
    const subscription = agencyData.subscription || { activePlan: 'starter_trial', status: 'trial', propertiesLimit: 1, unitsLimit: 10 };
    const propertiesLimit = subscription.propertiesLimit || 1;
    const unitsLimit = subscription.unitsLimit || 10;

    // 2. Enforce Property Limit
    const propsQ = query(collection(db, 'properties'), where('agencyId', '==', agencyId));
    const propsSnap = await getDocs(propsQ);
    if (propsSnap.docs.length >= propertiesLimit) {
      throw new Error(`Plan Limit Exceeded: You have reached your limit of ${propertiesLimit} properties under your current subscription. Please upgrade your plan in the Billing dashboard to add more.`);
    }

    // 3. Enforce Unit Limit
    const unitsQ = query(collection(db, 'units'), where('agencyId', '==', agencyId));
    const unitsSnap = await getDocs(unitsQ);
    const currentUnitsCount = unitsSnap.docs.length;
    const newUnitsCount = units?.length || 0;
    if (currentUnitsCount + newUnitsCount > unitsLimit) {
      throw new Error(`Plan Limit Exceeded: Adding ${newUnitsCount} units will exceed your plan limit of ${unitsLimit} units (Currently using ${currentUnitsCount}/${unitsLimit}). Please upgrade your plan in the Billing dashboard.`);
    }

    const batch = writeBatch(db);
    const propertyRef = doc(collection(db, 'properties'));
    const propertyId = propertyRef.id;
    const propertyUnitIds = [];

    let totalRevenue = 0;

    const now = serverTimestamp();

    units.forEach((unit) => {
      const unitId = unit.unitId;
      const unitRef = doc(db, 'units', unitId);
      propertyUnitIds.push(unitId);

      const rent = parseFloat(unit.rentAmount) || 0;
      const deposit = parseFloat(unit.depositAmount) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;
      const electricity = parseFloat(unit.utilityFees?.electricityBill) || 0;

      const unitName = unit.unitName || unit.unitId;

      const unitTotal = rent + garbage + water + electricity;
      totalRevenue += unitTotal;

      const unitData = {
        unitId,
        unitName,
        propertyId,
        agencyId, // Save agencyId on unit too
        isVacant: true,
        category: unit.category || 'Standard',
        rentAmount: rent,
        depositAmount: deposit,
        utilityFees: { garbageFee: garbage, waterBill: water, electricityBill: electricity },
        createdAt: now,
      };

      batch.set(unitRef, unitData);
    });

    const propertyData = {
      propertyId,
      propertyName,
      address: address || '',
      agencyId,
      createdBy: userUid, // Track who created it
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: totalRevenue,
      propertyUnitIds,
      propertyVacantUnits: units.length,
      agencyCommission: agencyCommission !== undefined ? parseFloat(agencyCommission) : 8,
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
      if (owner.id) {
        propertyData.ownerId = owner.id;
      } else {
        // Automatically create a client from the owner details!
        try {
          let existingClientId = null;
          const clientsRef = collection(db, 'clients');
          const q = query(
            clientsRef,
            where('agencyId', '==', agencyId),
            where('name', '==', owner.name)
          );
          const querySnap = await getDocs(q);
          if (!querySnap.empty) {
            existingClientId = querySnap.docs[0].id;
          }

          if (existingClientId) {
            propertyData.ownerId = existingClientId;
          } else {
            // Create a new client!
            const newClientRef = doc(collection(db, 'clients'));
            let payoutMethod = 'bank';
            if (owner.bankDetails?.mpesaNumber) {
               const type = owner.bankDetails?.mpesaType || 'b2c';
               if (type === 'till') payoutMethod = 'mpesa_b2b_till';
               else if (type === 'paybill') payoutMethod = 'mpesa_b2b_paybill';
               else payoutMethod = 'mpesa_b2c';
            }
            const payoutDetails = payoutMethod !== 'bank'
              ? (owner.bankDetails?.mpesaNumber || owner.phone || '')
              : (owner.bankDetails?.bankName && owner.bankDetails?.accountNumber 
                 ? `${owner.bankDetails.bankName} - Account ${owner.bankDetails.accountNumber}`
                 : (owner.bankDetails?.accountNumber || ''));

            const newClient = {
              agencyId,
              name: owner.name,
              email: owner.email || '',
              phone: owner.phone || '',
              commissionRate: parseFloat(agencyCommission) || 10,
              payoutMethod,
              payoutType: owner.bankDetails?.mpesaType || 'b2c',
              payoutDetails,
              notes: `Auto-created during property registration of ${propertyName}`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

            await setDoc(newClientRef, newClient);
            propertyData.ownerId = newClientRef.id;
          }
        } catch (clientErr) {
          console.error('❌ Failed to auto-create client in createProperty:', clientErr);
        }
      }
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

    // Auto-assign the property to the creator's portfolio
    if (userUid) {
      const userRef = doc(db, 'users', userUid);
      batch.update(userRef, {
        assignedProperties: arrayUnion(propertyId)
      });
    }

    await batch.commit();

    console.log(`[SUCCESS] Property created: ${propertyName} | ${units.length} units | ID: ${propertyId}`);

    return {
      propertyId,
      propertyName,
      totalRevenue,
      durationMs: Date.now() - start,
    };
  }

  async updateProperty(id, { propertyName, address, units, caretaker, owner, waterMeterSettings, electricitySettings, agencyCommission }) {
    const start = Date.now();
    const propertyRef = doc(db, 'properties', id);
    const propertySnap = await getDoc(propertyRef);

    if (!propertySnap.exists()) {
      return null;
    }

    const oldPropertyData = propertySnap.data();
    const oldAgencyId = oldPropertyData.agencyId;

    // 1. Fetch Subscription Limits
    const agencyRef = doc(db, 'agencies', oldAgencyId);
    const agencySnap = await getDoc(agencyRef);
    const agencyData = agencySnap.exists() ? agencySnap.data() : {};
    const subscription = agencyData.subscription || { activePlan: 'starter_trial', status: 'trial', propertiesLimit: 1, unitsLimit: 10 };
    const unitsLimit = subscription.unitsLimit || 10;

    // 2. Count existing units that don't belong to this property, and add the updated list count
    const unitsQ = query(collection(db, 'units'), where('agencyId', '==', oldAgencyId));
    const unitsSnap = await getDocs(unitsQ);
    
    // Count how many units belong to OTHER properties
    const otherUnitsCount = unitsSnap.docs.filter(docSnap => docSnap.data().propertyId !== id).length;
    const newUnitsCount = units?.length || 0;
    
    if (otherUnitsCount + newUnitsCount > unitsLimit) {
      throw new Error(`Plan Limit Exceeded: Modifying this property to have ${newUnitsCount} units will exceed your plan limit of ${unitsLimit} units (Currently using ${otherUnitsCount} units in other properties). Please upgrade your plan in the Billing dashboard.`);
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
      const electricity = parseFloat(utilityFees.electricityBill) || 0;

      const unitTotal = rent + garbage + water + electricity;
      totalRevenue += unitTotal;

      if (isVacant === true) vacantCount++;

      const unitRef = doc(db, 'units', unitId);
      batch.set(
        unitRef,
        {
          unitName: unitName || unitId, // Update unitName
          rentAmount: rent,
          depositAmount: deposit, // Update deposit
          utilityFees: {
            garbageFee: garbage,
            waterBill: water,
            electricityBill: electricity
          },
          isVacant: !!isVacant,
          category: category || 'Standard',
        },
        { merge: true }
      );
    }

    const propertyUpdateData = {
      propertyName,
      address: address || '',
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
      if (owner.id) {
        propertyUpdateData.ownerId = owner.id;
      } else {
        // Automatically create a client from the owner details!
        try {
          let existingClientId = null;
          const clientsRef = collection(db, 'clients');
          const q = query(
            clientsRef,
            where('agencyId', '==', oldAgencyId),
            where('name', '==', owner.name)
          );
          const querySnap = await getDocs(q);
          if (!querySnap.empty) {
            existingClientId = querySnap.docs[0].id;
          }

          if (existingClientId) {
            propertyUpdateData.ownerId = existingClientId;
          } else {
            // Create a new client!
            const newClientRef = doc(collection(db, 'clients'));
            let payoutMethod = 'bank';
            if (owner.bankDetails?.mpesaNumber) {
               const type = owner.bankDetails?.mpesaType || 'b2c';
               if (type === 'till') payoutMethod = 'mpesa_b2b_till';
               else if (type === 'paybill') payoutMethod = 'mpesa_b2b_paybill';
               else payoutMethod = 'mpesa_b2c';
            }
            const payoutDetails = payoutMethod !== 'bank'
              ? (owner.bankDetails?.mpesaNumber || owner.phone || '')
              : (owner.bankDetails?.bankName && owner.bankDetails?.accountNumber 
                 ? `${owner.bankDetails.bankName} - Account ${owner.bankDetails.accountNumber}`
                 : (owner.bankDetails?.accountNumber || ''));

            const newClient = {
              agencyId: oldAgencyId,
              name: owner.name,
              email: owner.email || '',
              phone: owner.phone || '',
              commissionRate: parseFloat(agencyCommission) || 10,
              payoutMethod,
              payoutType: owner.bankDetails?.mpesaType || 'b2c',
              payoutDetails,
              notes: `Auto-created during property settings update of ${propertyName || 'property'}`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };

            await setDoc(newClientRef, newClient);
            propertyUpdateData.ownerId = newClientRef.id;
          }
        } catch (clientErr) {
          console.error('❌ Failed to auto-create client in updateProperty:', clientErr);
        }
      }
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
    
    const oldData = unitSnap.data();

    // Update the unit
    const rent = parseFloat(data.rentAmount) || 0;
    const deposit = parseFloat(data.depositAmount) || 0;
    const garbage = parseFloat(data.utilityFees?.garbageFee) || 0;
    const water = parseFloat(data.utilityFees?.waterBill) || 0;
    const electricity = parseFloat(data.utilityFees?.electricityBill) || 0;
    const waterMeterReading = (data.waterMeterReading !== undefined && data.waterMeterReading !== null && data.waterMeterReading !== '') ? parseFloat(data.waterMeterReading) : null;

    // Build update object
    const updateData = {
      unitName: data.unitName || unitId,
      rentAmount: rent,
      depositAmount: deposit,
      utilityFees: { garbageFee: garbage, waterBill: water, electricityBill: electricity },
      isVacant: data.isVacant !== undefined ? !!data.isVacant : unitSnap.data().isVacant,
      category: data.category || unitSnap.data().category,
      updatedAt: serverTimestamp(),
    };

    // Handle water meter reading if provided
    if (waterMeterReading !== null) {
      updateData.waterMeterReading = waterMeterReading;
      const now = new Date();
      const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      const recordedAtTimestamp = now.getTime();

      const existingReadings = unitSnap.data().waterMeterReadings || [];
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

    // Sync changes to the tenant if occupied
    const oldRent = parseFloat(oldData.rentAmount) || 0;
    const oldGarbage = parseFloat(oldData.utilityFees?.garbageFee) || 0;
    const oldWater = parseFloat(oldData.utilityFees?.waterBill) || 0;
    const oldElectricity = parseFloat(oldData.utilityFees?.electricityBill) || 0;
    const diff = (rent + garbage + water + electricity) - (oldRent + oldGarbage + oldWater + oldElectricity);

    if (diff !== 0 && oldData.tenantId) {
      try {
        const tenantRef = doc(db, 'tenants', oldData.tenantId);
        const tenantSnap = await getDoc(tenantRef);
        if (tenantSnap.exists()) {
          const tenantData = tenantSnap.data();
          const { getCurrentMonth } = require('../utils/dateHelper');
          const currentMonth = getCurrentMonth();
          
          let updateTenantData = {
            financialSummary: {
              ...(tenantData.financialSummary || {}),
              arrears: Math.max(0, (tenantData.financialSummary?.arrears || 0) + diff),
              balance: (tenantData.financialSummary?.balance || 0) - diff
            },
            arrears: Math.max(0, (tenantData.arrears || 0) + diff),
            updatedAt: serverTimestamp()
          };

          if (tenantData.monthlyPaymentTracking && tenantData.monthlyPaymentTracking.month === currentMonth) {
            const oldTracking = tenantData.monthlyPaymentTracking;
            const newExpected = (oldTracking.expectedAmount || 0) + diff;
            const newRemaining = Math.max(0, (oldTracking.remainingAmount || 0) + diff);
            
            let status = 'unpaid';
            const paid = oldTracking.paidAmount || 0;
            if (newRemaining <= 0) status = 'paid';
            else if (paid > 0) status = 'partial';
            
            updateTenantData.monthlyPaymentTracking = {
              ...oldTracking,
              expectedAmount: newExpected,
              remainingAmount: newRemaining,
              status: status,
              breakdown: {
                ...(oldTracking.breakdown || {}),
                rent: (oldTracking.breakdown?.rent || 0) + (rent - oldRent),
                utilities: (oldTracking.breakdown?.utilities || 0) + (garbage + water + electricity - oldGarbage - oldWater - oldElectricity)
              }
            };
          }

          await setDoc(tenantRef, updateTenantData, { merge: true });
          console.log(`[PropertyService] Synced unit changes to tenant ${oldData.tenantId}. Diff: ${diff}`);
        }
      } catch (err) {
        console.error('Failed to sync unit update to tenant:', err);
      }
    }

    return {
      success: true,
      unitId,
      durationMs: Date.now() - start,
    };
  }

  async deleteProperty(propertyId) {
    const start = Date.now();
    const property = await this.getPropertyById(propertyId);
    if (!property) throw new Error('Property not found');

    const hasActiveTenants = property.units.some(unit => !unit.isVacant);
    if (hasActiveTenants) throw new Error('Cannot delete property with active tenants.');

    const batch = writeBatch(db);
    property.units.forEach(unit => {
      const unitRef = doc(db, 'units', unit.unitId);
      batch.delete(unitRef);
    });
    const propertyRef = doc(db, 'properties', propertyId);
    batch.delete(propertyRef);
    await batch.commit();
    return { success: true };
  }

}

module.exports = new PropertyService();