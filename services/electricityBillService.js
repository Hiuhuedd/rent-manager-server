// ============================================
// FILE: src/services/electricityBillService.js
// ============================================
const { db } = require('../config/firebase');
const {
    collection,
    getDocs,
    getDoc,
    doc,
    setDoc,
    query,
    where,
    serverTimestamp,
} = require('firebase/firestore');
const { getCurrentMonth } = require('../utils/dateHelper');

class ElectricityBillService {
    /**
     * Save or update electricity bills for a property for a specific month
     * @param {string} propertyId - Property ID
     * @param {string} month - Month in YYYY-MM format
     * @param {Array} bills - Array of { unitId, previousReading, currentReading, totalBill }
     */
    async saveElectricityBills(propertyId, month, bills, agencyId) {
        const start = Date.now();
        const targetMonth = month || getCurrentMonth();

        // Validate property exists and belongs to agency
        const propertyRef = doc(db, 'properties', propertyId);
        const propertySnap = await getDoc(propertyRef);

        if (!propertySnap.exists()) {
            throw new Error('Property not found');
        }

        const propertyData = propertySnap.data();
        
        // Security Check
        if (agencyId && propertyData.agencyId !== agencyId) {
            throw new Error('Unauthorized: Property belongs to another agency');
        }
        const elecSettings = propertyData.electricitySettings;

        if (!elecSettings || !elecSettings.rate1) {
            throw new Error('Electricity tariff settings not found for this property');
        }

        // Create or update electricity bill document
        const elecBillRef = doc(db, 'electricity_bills', `${propertyId}_${targetMonth}`);

        const elecBillData = {
            propertyId,
            propertyName: propertyData.propertyName,
            month: targetMonth,
            settings: elecSettings,
            bills: bills.map(bill => ({
                unitId: bill.unitId,
                unitCode: bill.unitCode || bill.unitId,
                unitName: bill.unitName || bill.unitCode || bill.unitId,
                previousReading: parseFloat(bill.previousReading) || 0,
                currentReading: parseFloat(bill.currentReading) || 0,
                unitsConsumed: (parseFloat(bill.currentReading) || 0) - (parseFloat(bill.previousReading) || 0),
                totalBill: parseFloat(bill.totalBill) || 0,
            })),
            totalAmount: bills.reduce((sum, bill) => sum + (parseFloat(bill.totalBill) || 0), 0),
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
        };

        await setDoc(elecBillRef, elecBillData, { merge: true });

        // Update each unit
        for (const bill of bills) {
            const unitRef = doc(db, 'units', bill.unitId);
            const unitSnap = await getDoc(unitRef);

            if (unitSnap.exists()) {
                const existingReadings = unitSnap.data().electricityMeterReadings || [];

                const readingIndex = existingReadings.findIndex(r => r.month === targetMonth);
                const readingEntry = {
                    month: targetMonth,
                    previousReading: parseFloat(bill.previousReading) || 0,
                    currentReading: parseFloat(bill.currentReading) || 0,
                    unitsConsumed: parseFloat(bill.currentReading || 0) - parseFloat(bill.previousReading || 0),
                    totalBill: parseFloat(bill.totalBill) || 0,
                    recordedAt: Date.now(),
                };

                if (readingIndex >= 0) {
                    existingReadings[readingIndex] = readingEntry;
                } else {
                    existingReadings.push(readingEntry);
                }

                await setDoc(unitRef, {
                    electricityMeterReading: parseFloat(bill.currentReading) || 0,
                    electricityMeterReadings: existingReadings,
                    utilityFees: {
                        ...(unitSnap.data().utilityFees || {}),
                        electricityBill: parseFloat(bill.totalBill) || 0,
                    },
                    updatedAt: serverTimestamp(),
                }, { merge: true });

                // Update tenant tracking if exists
                await this.updateTenantTracking(bill.unitId, targetMonth, parseFloat(bill.totalBill) || 0);
            }
        }

        // Recalculate property revenue
        await this.recalculatePropertyRevenue(propertyId);

        return {
            success: true,
            propertyId,
            month: targetMonth,
            billCount: bills.length,
            totalAmount: elecBillData.totalAmount,
            durationMs: Date.now() - start,
        };
    }

    async updateTenantTracking(unitId, month, electricityBill) {
        const unitRef = doc(db, 'units', unitId);
        const unitSnap = await getDoc(unitRef);
        if (!unitSnap.exists()) return;

        const unitData = unitSnap.data();
        const tenantId = unitData.tenantId;
        if (!tenantId) return;

        const tenantRef = doc(db, 'tenants', tenantId);
        const tenantSnap = await getDoc(tenantRef);
        if (!tenantSnap.exists()) return;

        const tenantData = tenantSnap.data();
        const oldTracking = tenantData.monthlyPaymentTracking || {};
        const oldElec = tenantData.utilityFees?.electricityBill || 0;

        const diff = electricityBill - oldElec;
        if (diff === 0 && oldTracking.month === month) return;

        // Simple approach: update expected amount and arrears
        const newExpected = (oldTracking.expectedAmount || 0) + diff;
        const newRemaining = Math.max(0, (oldTracking.remainingAmount || 0) + diff);

        let status = 'unpaid';
        const paid = oldTracking.paidAmount || 0;
        if (newRemaining <= 0) status = 'paid';
        else if (paid > 0) status = 'partial';

        const updatedTracking = {
            ...oldTracking,
            month: month, // Ensure month matches
            expectedAmount: newExpected,
            remainingAmount: newRemaining,
            status: status,
            breakdown: {
                ...(oldTracking.breakdown || {}),
                utilities: (oldTracking.breakdown?.utilities || 0) + diff
            }
        };

        const updatedUtilityFees = {
            ...(tenantData.utilityFees || {}),
            electricityBill: electricityBill
        };

        await setDoc(tenantRef, {
            utilityFees: updatedUtilityFees,
            monthlyPaymentTracking: updatedTracking,
            financialSummary: {
                ...tenantData.financialSummary,
                arrears: Math.max(0, (tenantData.financialSummary?.arrears || 0) + diff),
                balance: (tenantData.financialSummary?.balance || 0) - diff,
            },
            arrears: Math.max(0, (tenantData.arrears || 0) + diff),
            updatedAt: serverTimestamp(),
        }, { merge: true });
    }

    async recalculatePropertyRevenue(propertyId) {
        const propertyRef = doc(db, 'properties', propertyId);
        const propertySnap = await getDoc(propertyRef);
        if (!propertySnap.exists()) return;

        const propertyData = propertySnap.data();
        const unitIds = propertyData.propertyUnitIds || [];

        let totalRevenue = 0;
        if (unitIds.length > 0) {
            const unitRefs = unitIds.map(id => doc(db, 'units', id));
            const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));

            unitSnaps.forEach(snap => {
                if (snap.exists()) {
                    const uData = snap.data();
                    const rent = parseFloat(uData.rentAmount) || 0;
                    const garbage = parseFloat(uData.utilityFees?.garbageFee) || 0;
                    const water = parseFloat(uData.utilityFees?.waterBill) || 0;
                    const elec = parseFloat(uData.utilityFees?.electricityBill) || 0;
                    const monthlyRent = rent + garbage + water + elec;
                    totalRevenue += monthlyRent;
                }
            });
        }

        // Recalculate property revenue including water bills
        const targetMonth = getCurrentMonth(); // This might be problematic if called from a specific month save
        // Actually, the electricityBillService recalculatePropertyRevenue doesn't take month.
        // It seems to be a general revenue estimate based on current utilityFees on units.
        // That's fine as a general estimate.

        await setDoc(propertyRef, {
            propertyRevenueTotal: totalRevenue,
            updatedAt: serverTimestamp(),
        }, { merge: true });
    }

    /**
     * Get electricity bills for a property for a specific month
     * @param {string} propertyId - Property ID
     * @param {string} month - Month in YYYY-MM format
     */
    async getElectricityBills(propertyId, month, agencyId) {
        const targetMonth = month || getCurrentMonth();
        const elecBillRef = doc(db, 'electricity_bills', `${propertyId}_${targetMonth}`);
        const elecBillSnap = await getDoc(elecBillRef);

        if (!elecBillSnap.exists()) {
            // New logic to initialize list with previous readings
            const propertyRef = doc(db, 'properties', propertyId);
            const propertySnap = await getDoc(propertyRef);

            if (!propertySnap.exists()) {
                throw new Error('Property not found');
            }

            const propertyData = propertySnap.data();
            
            // Security Check
            if (agencyId && propertyData.agencyId !== agencyId) {
                throw new Error('Unauthorized: Property belongs to another agency');
            }
            const unitIds = propertyData.propertyUnitIds || [];

            const bills = [];
            for (const unitId of unitIds) {
                const unitRef = doc(db, 'units', unitId);
                const unitSnap = await getDoc(unitRef);
                if (unitSnap.exists()) {
                    const unitData = unitSnap.data();
                    const readings = unitData.electricityMeterReadings || [];

                    // Get most recent reading
                    const previousReading = this.getPreviousMonthReading(readings, targetMonth);

                    bills.push({
                        unitId: unitData.unitId,
                        unitCode: unitData.unitId,
                        unitName: unitData.unitName || unitData.unitId,
                        previousReading: previousReading,
                        currentReading: 0,
                        unitsConsumed: 0,
                        totalBill: 0,
                    });
                }
            }

            return {
                propertyId,
                propertyName: propertyData.propertyName,
                month: targetMonth,
                settings: propertyData.electricitySettings || {},
                bills: bills,
                totalAmount: 0,
                exists: false,
            };
        }

        // Security Check: Ensure the data we found belongs to the agency
        const data = elecBillSnap.data();
        if (agencyId && data.agencyId && data.agencyId !== agencyId) {
            throw new Error('Unauthorized: Electricity bills belong to another agency');
        }

        return {
            ...data,
            exists: true,
        };
    }

    getPreviousMonthReading(readings, targetMonth) {
        if (!readings || readings.length === 0) return 0;

        const [targetYear, targetMonthNum] = targetMonth.split('-').map(Number);
        const targetDate = new Date(targetYear, targetMonthNum - 1, 1);

        const previousReadings = readings
            .filter(r => {
                const [year, month] = r.month.split('-').map(Number);
                const readingDate = new Date(year, month - 1, 1);
                return readingDate < targetDate;
            })
            .sort((a, b) => {
                const [yearA, monthA] = a.month.split('-').map(Number);
                const [yearB, monthB] = b.month.split('-').map(Number);
                const dateA = new Date(yearA, monthA - 1, 1);
                const dateB = new Date(yearB, monthB - 1, 1);
                return dateB - dateA;
            });

        if (previousReadings.length === 0) return 0;

        return previousReadings[0].currentReading || 0;
    }
}

module.exports = new ElectricityBillService();
