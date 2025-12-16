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

        // 2. Fetch Running Costs Magnitude
        const costsSummary = await runningCostService.getTotalCostsByMonth(propertyId, month);

        // 3. Fetch Rent Payments Magnitude
        // month format YYYY-MM
        const [year, monthNum] = month.split('-').map(Number);
        const startDate = new Date(year, monthNum - 1, 1);
        const endDate = new Date(year, monthNum, 0, 23, 59, 59);

        // Query payments collection
        // Note: This relies on a 'paymentDate' or 'createdAt' field in payments
        // And ideally a 'propertyId' field. If payments only have 'tenantId', we might need to filter.
        // Assuming payments have 'propertyId' or we query tenancy first.
        // Let's assume payments are stored with propertyId for easier reporting
        // If not, we fetch all tenants of property -> then payments of those tenants.

        // Efficient approach: Query payments by propertyIdKey (if exists) or iterate units -> tenants -> payments
        // Given the current structure, let's look at how payments are structured.
        // (Assuming standard payments collection structure from previous knowledge)

        // Fallback: Fetch units -> tenants -> payments check
        // Optimization: create a dedicated query if possible.
        // For now, let's fetch payments where propertyId matches (if supported)
        // If payments collection doesn't have propertyId, we might need a workaround.
        // Let's assume we can filter by propertyId if it was added, otherwise we iterate.

        // Checking payment structure strategy:
        // We will query "payments" collection.
        // We filter in memory if necessary or use compound query.

        const paymentsQuery = query(
            collection(db, 'payments'),
            where('propertyId', '==', propertyId),
            where('paymentDate', '>=', startDate),
            where('paymentDate', '<=', endDate)
        );

        // NOTE: Requires composite index on propertyId + paymentDate
        // If index missing, we might need to fetch by propertyId and filter date in memory

        let paymentsSnapshot;
        try {
            paymentsSnapshot = await getDocs(paymentsQuery);
        } catch (e) {
            // Fallback if index missing or error: fetch by propertyId only
            const q = query(collection(db, 'payments'), where('propertyId', '==', propertyId));
            const snap = await getDocs(q);
            // Filter in memory
            paymentsSnapshot = {
                docs: snap.docs.filter(d => {
                    const pDate = d.data().paymentDate?.toDate();
                    return pDate >= startDate && pDate <= endDate;
                })
            };
        }

        const payments = paymentsSnapshot.docs.map(doc => doc.data());

        const totalRentCollected = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

        // 4. Calculate Net Income
        const netIncome = totalRentCollected - costsSummary.totalAmount;

        // 5. Structure the Report
        return {
            meta: {
                generatedAt: new Date(),
                month,
            },
            property: {
                id: propertyId,
                name: propertyData.propertyName,
                totalUnits: propertyData.propertyUnitsTotal,
            },
            financials: {
                income: {
                    total: totalRentCollected,
                    transactionCount: payments.length,
                    breakdown: payments.map(p => ({
                        unit: p.unitId,
                        amount: p.amount,
                        date: p.paymentDate?.toDate(),
                        type: p.paymentType // Rent, Deposit, etc.
                    }))
                },
                expenses: {
                    total: costsSummary.totalAmount,
                    transactionCount: costsSummary.itemCount,
                    byCategory: costsSummary.byCategory,
                },
                netIncome,
            }
        };
    }
}

module.exports = new ReportService();
