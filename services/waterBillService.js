// ============================================
// FILE: src/services/waterBillService.js
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

class WaterBillService {
    /**
     * Save or update water bills for a property for a specific month
     * @param {string} propertyId - Property ID
     * @param {string} month - Month in YYYY-MM format
     * @param {Array} bills - Array of { unitId, previousReading, currentReading, costPerUnit, totalBill }
     */
    async saveWaterBills(propertyId, month, bills, agencyId) {
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
        const waterMeterType = propertyData.waterMeterSettings?.meterType || 'single';

        if (waterMeterType !== 'individual') {
            throw new Error('Water bills can only be entered for properties with individual meters');
        }

        // Create or update water bill document for this property-month combination
        const waterBillRef = doc(db, 'water_bills', `${propertyId}_${targetMonth}`);

        const waterBillData = {
            propertyId,
            propertyName: propertyData.propertyName,
            month: targetMonth,
            meterType: waterMeterType,
            costPerUnit: propertyData.waterMeterSettings?.costPerUnit || 95,
            bills: bills.map(bill => ({
                unitId: bill.unitId,
                unitCode: bill.unitCode || bill.unitId,
                unitName: bill.unitName || bill.unitCode || bill.unitId,
                previousReading: parseFloat(bill.previousReading) || 0,
                currentReading: parseFloat(bill.currentReading) || 0,
                unitsConsumed: (parseFloat(bill.currentReading) || 0) - (parseFloat(bill.previousReading) || 0),
                costPerUnit: parseFloat(bill.costPerUnit) || propertyData.waterMeterSettings?.costPerUnit || 95,
                totalBill: parseFloat(bill.totalBill) || 0,
            })),
            totalAmount: bills.reduce((sum, bill) => sum + (parseFloat(bill.totalBill) || 0), 0),
            updatedAt: serverTimestamp(),
            createdAt: serverTimestamp(),
        };

        await setDoc(waterBillRef, waterBillData, { merge: true });

        // Update each unit's water meter reading and water bill
        for (const bill of bills) {
            const unitRef = doc(db, 'units', bill.unitId);
            const unitSnap = await getDoc(unitRef);

            if (unitSnap.exists()) {
                const existingReadings = unitSnap.data().waterMeterReadings || [];

                // Update or add reading for current month
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
                    waterMeterReading: parseFloat(bill.currentReading) || 0,
                    waterMeterReadings: existingReadings,
                    utilityFees: {
                        garbageFee: unitSnap.data().utilityFees?.garbageFee || 0,
                        waterBill: parseFloat(bill.totalBill) || 0,
                    },
                    updatedAt: serverTimestamp(),
                }, { merge: true });
            }
        }

        // Recalculate property revenue to include water bills
        // We recalculate from scratch to ensure idempotency (avoid adding twice)
        // Fetch fresh property and unit data to calculate Total Revenue = Rent + Garbage + Water
        const freshPropertySnap = await getDoc(propertyRef);
        if (freshPropertySnap.exists()) {
            const freshPropData = freshPropertySnap.data();
            const unitIds = freshPropData.propertyUnitIds || [];

            let totalRent = 0;
            let totalGarbage = 0;

            if (unitIds.length > 0) {
                const unitRefs = unitIds.map(id => doc(db, 'units', id));
                const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));

                unitSnaps.forEach(snap => {
                    if (snap.exists()) {
                        const uData = snap.data();
                        totalRent += parseFloat(uData.rentAmount) || 0;
                        totalGarbage += parseFloat(uData.utilityFees?.garbageFee) || 0;
                    }
                });
            }

            // Fetch total electricity bills for this month
            let totalElectricityBills = 0;
            try {
                const elecBillId = `${propertyId}_${targetMonth}`;
                const elecBillSnap = await getDoc(doc(db, 'electricity_bills', elecBillId));
                if (elecBillSnap.exists()) {
                    totalElectricityBills = parseFloat(elecBillSnap.data().totalAmount) || 0;
                }
            } catch (e) {
                console.warn(`[REVENUE] Failed to fetch electricity bills for revenue recalculation:`, e.message);
            }

            // Calculate total water bills for this month from the bills we just saved
            const totalWaterBills = bills.reduce((sum, bill) => sum + (parseFloat(bill.totalBill) || 0), 0);
            const totalRevenue = totalRent + totalGarbage + totalWaterBills + totalElectricityBills;

            await setDoc(propertyRef, {
                propertyRevenueTotal: totalRevenue,
                updatedAt: serverTimestamp(),
            }, { merge: true });

            console.log(`[SUCCESS] Property revenue recalculated: Rent(${totalRent}) + Garbage(${totalGarbage}) + Water(${totalWaterBills}) + Elec(${totalElectricityBills}) = ${totalRevenue}`);
        }

        // Update tenant monthly tracking for affected units
        // Use the billing month targetMonth, not necessarily actual current month
        const currentMonth = targetMonth;
        for (const bill of bills) {
            const unitRef = doc(db, 'units', bill.unitId);
            const unitSnap = await getDoc(unitRef);

            if (unitSnap.exists()) {
                const unitData = unitSnap.data();
                const tenantId = unitData.tenantId;

                if (tenantId) {
                    const tenantRef = doc(db, 'tenants', tenantId);
                    const tenantSnap = await getDoc(tenantRef);

                    if (tenantSnap.exists()) {
                        const tenantData = tenantSnap.data();
                        let monthlyTracking = tenantData.monthlyPaymentTracking;

                        const rent = parseFloat(unitData.rentAmount) || 0;
                        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
                        const water = parseFloat(bill.totalBill) || 0;

                        // Initialize or update monthly tracking
                        // RECALCULATE paid amount from actual payments array to be robust
                        let existingPaid = 0;
                        let existingPayments = [];

                        if (tenantData.payments && Array.isArray(tenantData.payments)) {
                            // Filter for payments in this target month
                            const monthPayments = tenantData.payments.filter(p => {
                                const match = p.paymentMonth === currentMonth;
                                return match;
                            });

                            existingPaid = monthPayments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
                            existingPayments = monthPayments;
                        } else if (monthlyTracking && monthlyTracking.month === currentMonth) {
                            existingPaid = monthlyTracking.paidAmount || 0;
                            existingPayments = monthlyTracking.payments || [];
                        }

                        const { isMovedInThisMonth } = require('../utils/dateHelper');
                        const { DEPOSIT_STATUS } = require('../config/constants');

                        const deposit = parseFloat(unitData.depositAmount) || 0;
                        const isNewTenant = isMovedInThisMonth(tenantData.moveInDate || new Date().toISOString());
                        const depositPending = tenantData.rentDeposit?.status === DEPOSIT_STATUS.PENDING;
                        const includeDeposit = isNewTenant && depositPending && deposit > 0;

                        const monthlyRent = rent + garbage + water;
                        const totalExpected = monthlyRent + (includeDeposit ? deposit : 0);
                        const totalRemaining = Math.max(0, totalExpected - existingPaid);

                        let status = 'unpaid';
                        if (totalRemaining <= 0) status = 'paid';
                        else if (existingPaid > 0) status = 'partial';

                        const oldExpected = tenantData.monthlyPaymentTracking?.expectedAmount || 0;

                        monthlyTracking = {
                            month: currentMonth,
                            expectedAmount: totalExpected,
                            paidAmount: existingPaid,
                            remainingAmount: totalRemaining,
                            status: status,
                            payments: existingPayments,
                            breakdown: {
                                deposit: includeDeposit ? deposit : 0,
                                rent: rent,
                                utilities: garbage + water,
                            },
                            includesDeposit: includeDeposit,
                            depositRequired: includeDeposit ? deposit : 0,
                        };

                        console.log(`[INFO] Updated monthly tracking for tenant ${tenantId}: Expected ${oldExpected} → ${totalExpected}, Paid: ${existingPaid}, Status: ${status}, Water: ${water}`);

                        // Calculate arrears adjustment
                        // If we are updating the current month, the difference in expected amount adds to arrears
                        // But we must be careful not to double count if we run this multiple times.
                        // The safest way is to recalculate arrears based on total history, but that's expensive.
                        // A simpler way: The difference between NEW expected and OLD expected for THIS month is added to arrears.
                        const arrearsAdjustment = totalExpected - oldExpected;

                        // Update monthly tracking AND tenant utility fees
                        const updatedUtilityFees = {
                            ...(tenantData.utilityFees || {}),
                            waterBill: water,
                            garbageFee: garbage
                        };

                        await setDoc(tenantRef, {
                            utilityFees: updatedUtilityFees,
                            monthlyPaymentTracking: monthlyTracking,
                            financialSummary: {
                                ...tenantData.financialSummary,
                                totalPaid: tenantData.financialSummary?.totalPaid || 0,
                                arrears: Math.max(0, (tenantData.financialSummary?.arrears || 0) + arrearsAdjustment),
                                balance: (tenantData.financialSummary?.balance || 0) - arrearsAdjustment,
                            },
                            arrears: Math.max(0, (tenantData.arrears || 0) + arrearsAdjustment),
                            updatedAt: serverTimestamp(),
                        }, { merge: true });
                    }
                }
            }
        }

        console.log(`[SUCCESS] Water bills saved for property ${propertyId}, month ${targetMonth} | Duration: ${Date.now() - start} ms`);

        return {
            success: true,
            propertyId,
            month: targetMonth,
            billCount: bills.length,
            totalAmount: waterBillData.totalAmount,
            durationMs: Date.now() - start,
        };
    }

    /**
     * Get water bills for a property for a specific month
     * @param {string} propertyId - Property ID
     * @param {string} month - Month in YYYY-MM format (optional, defaults to current month)
     */
    async getWaterBills(propertyId, month, agencyId) {
        const targetMonth = month || getCurrentMonth();
        const waterBillRef = doc(db, 'water_bills', `${propertyId}_${targetMonth}`);
        const waterBillSnap = await getDoc(waterBillRef);

        if (!waterBillSnap.exists()) {
            // Return empty structure if no bills exist for this month
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

            // Fetch all units to get previous readings
            const units = [];
            for (const unitId of unitIds) {
                const unitRef = doc(db, 'units', unitId);
                const unitSnap = await getDoc(unitRef);
                if (unitSnap.exists()) {
                    const unitData = unitSnap.data();
                    const readings = unitData.waterMeterReadings || [];

                    // Find the most recent reading before this month
                    const previousReading = this.getPreviousMonthReading(readings, targetMonth);

                    units.push({
                        unitId: unitData.unitId,
                        unitCode: unitData.unitId,
                        unitName: unitData.unitName || unitData.unitId,
                        previousReading: previousReading,
                        currentReading: 0,
                        unitsConsumed: 0,
                        costPerUnit: propertyData.waterMeterSettings?.costPerUnit || 95,
                        totalBill: 0,
                    });
                }
            }

            return {
                propertyId,
                propertyName: propertyData.propertyName,
                month: targetMonth,
                meterType: propertyData.waterMeterSettings?.meterType || 'single',
                costPerUnit: propertyData.waterMeterSettings?.costPerUnit || 95,
                bills: units,
                totalAmount: 0,
                exists: false,
            };
        }

        const data = waterBillSnap.data();

        // Enrich with unit names from units collection for legacy records or safety
        const enrichedBills = await Promise.all(data.bills.map(async (bill) => {
            // Security Check: Ensure the data we found belongs to the agency
            if (agencyId && data.agencyId && data.agencyId !== agencyId) {
                throw new Error('Unauthorized: Water bills belong to another agency');
            }
            
            if (bill.unitName) return bill;

            try {
                const unitSnap = await getDoc(doc(db, 'units', bill.unitId));
                if (unitSnap.exists()) {
                    return { ...bill, unitName: unitSnap.data().unitName || unitSnap.data().unitId };
                }
            } catch (err) {
                console.warn(`[WATER_BILL] Failed to enrich unit ${bill.unitId} name:`, err.message);
            }
            return bill;
        }));

        return {
            ...data,
            bills: enrichedBills,
            exists: true,
        };
    }

    /**
     * Get previous month's reading for a unit
     * @param {Array} readings - Array of water meter readings
     * @param {string} targetMonth - Target month in YYYY-MM format
     */
    getPreviousMonthReading(readings, targetMonth) {
        if (!readings || readings.length === 0) return 0;

        const [targetYear, targetMonthNum] = targetMonth.split('-').map(Number);
        const targetDate = new Date(targetYear, targetMonthNum - 1, 1);

        // Filter readings before target month and sort by date descending
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

    /**
     * Get water bill history for a property
     * @param {string} propertyId - Property ID
     */
    async getWaterBillHistory(propertyId, agencyId) {
        const waterBillsQuery = query(
            collection(db, 'water_bills'),
            where('propertyId', '==', propertyId),
            where('agencyId', '==', agencyId)
        );

        const waterBillsSnap = await getDocs(waterBillsQuery);
        const history = waterBillsSnap.docs
            .map(doc => ({
                id: doc.id,
                ...doc.data(),
            }))
            .sort((a, b) => b.month.localeCompare(a.month)); // Sort by month descending

        return history;
    }
}

module.exports = new WaterBillService();
