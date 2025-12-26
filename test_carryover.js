
const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
const { processRentalPayment, getCurrentMonth, resetMonthlyPaymentTracking } = require('./smsProcessor');
const tenantService = require('./services/tenantService');

const db = getFirestoreApp();

async function runCarryOverTest() {
    console.log('🚀 Starting Carry-over Verification Test...');

    // 1. Find a test tenant
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    if (tenantsSnapshot.empty) {
        console.error('❌ No tenants found for testing');
        return;
    }

    const testTenant = { id: tenantsSnapshot.docs[0].id, ...tenantsSnapshot.docs[0].data() };
    console.log(`👤 Using Test Tenant: ${testTenant.name} (${testTenant.id})`);

    // 2. Setup a known state
    // We want a constant expected amount, say 15,000.
    // We'll simulate a payment that creates a balance.

    // First, ensure tracking is initialized for current month
    await tenantService.getPaymentStatus(testTenant.id);
    const initialSnap = await getDoc(doc(db, 'tenants', testTenant.id));
    const initialTenant = initialSnap.data();

    const monthlyRent = initialTenant.monthlyPaymentTracking.expectedAmount;
    console.log(`   - Monthly Rent (Current): ${monthlyRent}`);

    // payment = Rent + 5000 excess
    const paymentAmount = monthlyRent + 5000;
    const transactionId = `CARRY-${Date.now()}`;

    console.log(`💰 Simulating Overflow Payment of KSh ${paymentAmount}...`);

    const payResult = await processRentalPayment({
        transactionId,
        amount: paymentAmount,
        accountNumber: initialTenant.phone,
        senderPhone: initialTenant.phone,
        senderPhoneNormalized: initialTenant.phone,
        accountNumberNormalized: initialTenant.phone,
        paymentMonth: getCurrentMonth(),
        date: new Date().toISOString(),
        senderName: initialTenant.name
    });

    if (!payResult.success) {
        console.error('❌ Payment Failed:', payResult.error);
        return;
    }

    const postPaySnap = await getDoc(doc(db, 'tenants', testTenant.id));
    const postPayTenant = postPaySnap.data();
    console.log(`   - Status: ${postPayTenant.monthlyPaymentTracking.status}`);
    console.log(`   - New Balance (Post-Payment): ${postPayTenant.financialSummary.balance}`);
    console.log(`   - New Arrears (Post-Payment): ${postPayTenant.financialSummary.arrears}`);

    // 3. Simulate Next Month Carry-over
    console.log('\n📅 Simulating Month Rollover...');
    // Force a month that is definitely different from current
    await updateDoc(doc(db, 'tenants', testTenant.id), {
        "monthlyPaymentTracking.month": "2024-01"
    });

    // Now trigger reset (which calls getPaymentStatus)
    const resetResult = await resetMonthlyPaymentTracking();
    console.log(`✅ Reset triggered. Tenants processed: ${resetResult.resetCount}`);

    // 4. Final Verification
    const finalSnap = await getDoc(doc(db, 'tenants', testTenant.id));
    const finalTenant = finalSnap.data();

    console.log('\n🔍 Verifying Next Month Tracking (Month: ' + finalTenant.monthlyPaymentTracking.month + '):');
    console.log(`   - Paid Amount (from carry-over): ${finalTenant.monthlyPaymentTracking.paidAmount}`);
    console.log(`   - Remaining: ${finalTenant.monthlyPaymentTracking.remainingAmount}`);
    console.log(`   - Status: ${finalTenant.monthlyPaymentTracking.status}`);
    console.log(`   - Overall Balance: ${finalTenant.financialSummary.balance}`);
    console.log(`   - Overall Arrears: ${finalTenant.financialSummary.arrears}`);

    // Correcting the expectation:
    // If we had 5000 excess, and new month rent is 30,700.
    // CarryOver should be 5000.
    // Remaining should be 25,700.
    // Balance should be existingBalance (5000) - new charge (30,700) = -25,700.

    const expectedCarryOver = 5000;
    const expectedRemaining = Math.max(0, monthlyRent - 5000);
    const expectedFinalBalance = 5000 - monthlyRent;

    console.log(`\n⚖️ Expectations:`);
    console.log(`   - CarryOver: ${expectedCarryOver} (Got: ${finalTenant.monthlyPaymentTracking.paidAmount})`);
    console.log(`   - Remaining: ${expectedRemaining} (Got: ${finalTenant.monthlyPaymentTracking.remainingAmount})`);
    console.log(`   - Final Balance: ${expectedFinalBalance} (Got: ${finalTenant.financialSummary.balance})`);

    if (finalTenant.monthlyPaymentTracking.paidAmount === expectedCarryOver &&
        finalTenant.monthlyPaymentTracking.remainingAmount === expectedRemaining) {
        console.log('\n✨ CARRY-OVER TEST PASSED!');
    } else {
        console.log('\n❌ CARRY-OVER TEST FAILED: Verification mismatch.');
    }
}

runCarryOverTest().catch(console.error);
