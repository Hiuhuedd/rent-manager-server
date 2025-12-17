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
        console.log(`[ReportService] Generating report for Property: ${propertyId}, Month: ${month}`);

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

        // STRATEGY: Fetch all tenants for this property first, then filter payments by those tenants.
        // This is more robust than relying on 'propertyId' existing on the payment record itself.

        // A. Fetch all tenants for this property
        const tenantsQuery = query(
            collection(db, 'tenants'),
            where('propertyId', '==', propertyId)
        );
        const tenantsSnap = await getDocs(tenantsQuery);
        const propertyTenants = tenantsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const tenantIds = new Set(propertyTenants.map(t => t.id));
        console.log(`[ReportService] Found ${propertyTenants.length} tenants for property.`);

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
                        unit: p.unitCode || p.unitId,
                        amount: p.amount,
                        date: p.timestamp ? new Date(p.timestamp) : (p.paymentDate ? new Date(p.paymentDate) : null),
                        type: 'Rent'
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
