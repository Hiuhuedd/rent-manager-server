
const { db } = require('../config/firebase');
const { collection, getDocs, query, where, getDoc, doc } = require('firebase/firestore');
const tenantService = require('../services/tenantService');
const { getCurrentMonth } = require('../utils/dateHelper');

async function verifyBalance() {
    const currentMonth = getCurrentMonth();
    console.log(`Checking for payments in ${currentMonth}...`);

    const paymentsQuery = query(
        collection(db, 'financial_records'),
        where('paymentMonth', '==', currentMonth)
    );

    const paymentsSnapshot = await getDocs(paymentsQuery);

    if (paymentsSnapshot.empty) {
        console.log('No payments found for this month. Cannot automatically verify deduction logic without mock data.');
        console.log('Please manually add a payment or trust the code changes.');
        process.exit(0);
    }

    // Aggregate payments by tenant for verification
    const realPayments = {};
    paymentsSnapshot.docs.forEach(doc => {
        const data = doc.data();
        if (data.tenantId) {
            realPayments[data.tenantId] = (realPayments[data.tenantId] || 0) + (data.amount || 0);
        }
    });

    const tenantId = Object.keys(realPayments)[0];
    const totalPaid = realPayments[tenantId];

    console.log(`Verifying Tenant ID: ${tenantId}`);
    console.log(`Total Paid This Month: ${totalPaid}`);

    // Get raw tenant data
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);
    const rawData = tenantSnap.data();
    const rawArrears = rawData.arrears || 0;

    console.log(`Raw Arrears in DB: ${rawArrears}`);

    // Call the service
    const allTenants = await tenantService.getAllTenants();
    const processedTenant = allTenants.find(t => t.id === tenantId);

    if (!processedTenant) {
        console.error('Tenant not found in getAllTenants result!');
        process.exit(1);
    }

    console.log(`Processed Arrears from Service: ${processedTenant.arrears}`);

    const expectedArrears = rawArrears - totalPaid;
    console.log(`Expected Arrears (Raw - Paid): ${expectedArrears}`);

    if (Math.abs(processedTenant.arrears - expectedArrears) < 0.01) {
        console.log('✅ Verification SUCCESS: Arrears correctly adjusted.');
    } else {
        console.error('❌ Verification FAILED: Arrears mismatch.');
    }

    process.exit(0);
}

verifyBalance().catch(console.error);
