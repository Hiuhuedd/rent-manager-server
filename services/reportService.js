// ============================================
// FILE: src/services/reportService.js
// ============================================
const { db } = require('../config/firebase');
const {
    collection,
    getDocs,
    query,
    where,
    getDoc,
    doc,
} = require('firebase/firestore');
const runningCostService = require('./runningCostService');
const settingsService = require('./settingsService');
const { isMovedInThisMonth } = require('../utils/dateHelper');
const { DEPOSIT_STATUS } = require('../config/constants');

class ReportService {
    /**
     * Generate a comprehensive monthly report for a property
     * Aggregates Rent Collected vs Running Costs
     */
    async generatePropertyReport(propertyId, month) {
        // 1. Fetch Property Details
        const propertyRef = doc(db, 'properties', propertyId);
        const propertySnap = await getDoc(propertyRef);
        if (!propertySnap.exists()) {
            throw new Error('Property not found');
        }
        const propertyData = propertySnap.data();

        // 4. Calculate Tenant Payment Statuses and Commission
        const agencySettings = await settingsService.getSettings();

        // 3. Fetch Rent Payments Magnitude
        // month format YYYY-MM
        const [year, monthNum] = month.split('-').map(Number);

        console.log(`[ReportService] Generating report for Property: ${propertyId}, Month: ${month}`);

        // STRATEGY: Fetch all tenants for this property first, then filter payments by those tenants.
        // This is more robust than relying on 'propertyId' existing on the payment record itself.

        // A. Fetch all tenants for this property
        const tenantsQuery = query(
            collection(db, 'tenants'),
            where('propertyId', '==', propertyId)
        );
        const tenantsSnap = await getDocs(tenantsQuery);
        const propertyTenants = tenantsSnap.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(t => {
                if (!t.createdAt) return true; // Include if no date (legacy support)

                // Parse createdAt (handle Firestore Timestamp or String/Date)
                const createdDate = t.createdAt.toDate ? t.createdAt.toDate() : new Date(t.createdAt);

                // Calculate Start of Next Month from Selected Month
                // selectedMonth is "YYYY-MM"
                const [y, m] = month.split('-').map(Number);
                const nextMonthDate = new Date(y, m, 1); // Month is 0-indexed in Date, so 'm' given 1-indexed input gives start of next month
                // e.g. 2023-12 -> new Date(2023, 12, 1) which is Jan 1st 2024. Correct.

                return createdDate < nextMonthDate;
            });

        const tenantIds = new Set(propertyTenants.map(t => t.id));
        console.log(`[ReportService] Found ${propertyTenants.length} tenants for property (after date filtering).`);

        // A2. Fetch all units for this property to get display names
        const unitsQuery = query(
            collection(db, 'units'),
            where('propertyId', '==', propertyId)
        );
        const unitsSnap = await getDocs(unitsQuery);
        const unitMap = {};
        unitsSnap.forEach(uDoc => {
            const uData = uDoc.data();
            // Map document ID, unitId, and unitCode to the display name and billing info
            const displayName = uData.unitName || uData.unitId || uData.unitCode || uDoc.id;
            const unitInfo = {
                displayName,
                rentAmount: parseFloat(uData.rentAmount) || 0,
                garbageFee: parseFloat(uData.utilityFees?.garbageFee) || 0
            };
            unitMap[uDoc.id] = unitInfo;
            if (uData.unitId) unitMap[uData.unitId] = unitInfo;
            if (uData.unitCode) unitMap[uData.unitCode] = unitInfo;
        });

        // A3. Fetch Water Bills for this month
        const waterBillDocRef = doc(db, 'water_bills', `${propertyId}_${month}`);
        const waterBillSnap = await getDoc(waterBillDocRef);
        const waterBillMap = {};
        if (waterBillSnap.exists()) {
            const wbData = waterBillSnap.data();
            if (wbData.bills) {
                wbData.bills.forEach(bill => {
                    waterBillMap[bill.unitId] = parseFloat(bill.totalBill) || 0;
                    if (bill.unitCode) waterBillMap[bill.unitCode] = parseFloat(bill.totalBill) || 0;
                });
            }
        }
        console.log(`[ReportService] Fetched water bills for ${Object.keys(waterBillMap).length} units.`);

        // B. Fetch all financial records for the month
        const paymentsQuery = query(
            collection(db, 'financial_records'),
            where('paymentMonth', '==', month)
        );

        const paymentsSnapshot = await getDocs(paymentsQuery);
        const allPayments = paymentsSnapshot.docs.map(doc => doc.data());
        console.log(`[ReportService] Fetched ${allPayments.length} total financial records for month.`);

        // C. Filter payments that belong to tenants of this property
        // We check if payment.tenantId matches one of our property's tenants
        // OR if payment.propertyId matches (for direct association)
        const payments = allPayments.filter(p =>
            tenantIds.has(p.tenantId) || p.propertyId === propertyId
        );
        console.log(`[ReportService] Filtered ${payments.length} payments relevant to property.`);

        const totalRentCollected = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
        console.log(`[ReportService] Total Rent Collected: ${totalRentCollected}`);

        // 2. Fetch Running Costs Magnitude
        const costsSummary = await runningCostService.getTotalCostsByMonth(propertyId, month);
        let totalAllocatedRent = 0;
        const tenantStatusList = propertyTenants.map(tenant => {
            const tenantPayments = payments.filter(p => p.tenantId === tenant.id);
            const amountPaid = tenantPayments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

            // Get latest payment date
            let lastPaymentDate = null;
            if (tenantPayments.length > 0) {
                const latestPayment = tenantPayments.sort((a, b) => {
                    const dateA = a.timestamp ? new Date(a.timestamp) : (a.paymentDate ? new Date(a.paymentDate) : 0);
                    const dateB = b.timestamp ? new Date(b.timestamp) : (b.paymentDate ? new Date(b.paymentDate) : 0);
                    return dateB - dateA;
                })[0];
                const date = latestPayment.timestamp ? new Date(latestPayment.timestamp) : (latestPayment.paymentDate ? new Date(latestPayment.paymentDate) : null);
                lastPaymentDate = date ? date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' }) : null;
            }

            // Get unit info from unitMap
            const unitInfo = unitMap[tenant.unitCode] || unitMap[tenant.unitId] || {};
            const unitDisplayName = unitInfo.displayName || tenant.unitName || tenant.unitId || 'N/A';

            // Calculate expected amount (Rent + Utilities + optional Deposit)
            const monthlyRent = unitInfo.rentAmount || parseFloat(tenant.rentAmount) || 0;
            const garbageFee = unitInfo.garbageFee || parseFloat(tenant.utilityFees?.garbageFee) || 0;
            const waterBill = waterBillMap[tenant.unitId] || waterBillMap[tenant.unitCode] || 0;

            // Deposit Logic: Only include if tenant moved in this month AND deposit is pending
            const deposit = parseFloat(unitInfo.depositAmount || tenant.rentDeposit?.amount) || 0;
            const isNewTenant = isMovedInThisMonth(tenant.moveInDate, month);
            const depositPending = tenant.rentDeposit?.status === DEPOSIT_STATUS.PENDING;
            const includeDeposit = isNewTenant && depositPending && deposit > 0;

            const expectedAmount = monthlyRent + garbageFee + waterBill + (includeDeposit ? deposit : 0);

            // Calculate Rent Portion of Paid Amount for Commission
            // Logic: Payment covers (1) Deposit (2) Utilities (3) Rent
            let remainingForRent = amountPaid;
            if (includeDeposit) remainingForRent = Math.max(0, remainingForRent - deposit);
            remainingForRent = Math.max(0, remainingForRent - (garbageFee + waterBill));

            // We only commission up to the monthly rent amount
            const allocatedRent = Math.min(monthlyRent, remainingForRent);
            totalAllocatedRent += allocatedRent;

            let status = 'Unpaid';
            if (amountPaid >= expectedAmount && expectedAmount > 0) {
                status = 'Paid';
            } else if (amountPaid > 0) {
                status = 'Partial';
            }

            const fullName = tenant.name || 'Unknown';
            const firstName = fullName.split(' ')[0];
            const truncatedName = firstName.length > 10 ? firstName.substring(0, 10) + '...' : firstName;

            return {
                tenantId: tenant.id,
                tenantName: truncatedName,
                unitName: unitDisplayName,
                rentAmount: monthlyRent,
                expectedAmount,
                amountPaid,
                unpaidAmount: Math.max(0, expectedAmount - amountPaid),
                status,
                paymentDate: lastPaymentDate || '-'
            };
        });

        // Calculate Totals from Tenant List
        const totalExpected = tenantStatusList.reduce((sum, t) => sum + t.expectedAmount, 0);
        const totalUnpaid = tenantStatusList.reduce((sum, t) => sum + t.unpaidAmount, 0);

        // 5. Calculate Agency Commission
        const commissionRate = propertyData.agencyCommission !== undefined ? propertyData.agencyCommission : 8;
        const agencyCommissionTotal = totalAllocatedRent * (commissionRate / 100);

        // 6. Calculate Net Income
        const totalExpenses = costsSummary.totalAmount + agencyCommissionTotal;
        const netIncome = totalRentCollected - totalExpenses;

        // 7. Structure the Report
        return {
            meta: {
                generatedAt: new Date(),
                month,
                agency: {
                    name: agencySettings.agencyName || 'RentManager Agency',
                    contact: agencySettings.customerServiceNumber || '',
                },
                owner: propertyData.owner || { name: 'N/A' }
            },
            property: {
                id: propertyId,
                name: propertyData.propertyName,
                totalUnits: propertyData.propertyUnitsTotal,
                summary: `${propertyData.propertyOccupiedUnits || 0} Occupied, ${propertyData.propertyVacantUnits || 0} Vacant`
            },
            financials: {
                income: {
                    total: totalRentCollected,
                    expected: totalExpected,
                    unpaid: totalUnpaid,
                    transactionCount: payments.length,
                    breakdown: payments.map(p => ({
                        unit: p.unitCode || p.unitId,
                        amount: p.amount,
                        date: p.timestamp ? new Date(p.timestamp) : (p.paymentDate ? new Date(p.paymentDate) : null),
                        type: 'Rent'
                    }))
                },
                expenses: {
                    total: totalExpenses,
                    transactionCount: costsSummary.itemCount + 1,
                    byCategory: {
                        ...costsSummary.byCategory,
                        'Agency Commission': agencyCommissionTotal
                    },
                    items: [
                        ...(costsSummary.items || []).map(c => ({
                            name: c.feeName || c.category,
                            amount: c.amount,
                            date: c.date
                        }))
                    ]
                },
                netIncome,
                commission: {
                    rate: commissionRate,
                    total: agencyCommissionTotal
                }
            },
            tenants: tenantStatusList
        };
    }
}

module.exports = new ReportService();
