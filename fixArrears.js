const { db } = require('./config/firebase');
const { collection, query, where, getDocs, updateDoc, doc } = require('firebase/firestore');

async function fixTenantArrears() {
    console.log("🔍 Scanning for Tenant with Phone 0743466032...");
    
    const tenantsQuery = query(collection(db, 'tenants'), where('phone', '==', '0743466032'));
    const snapshot = await getDocs(tenantsQuery);

    if (snapshot.empty) {
        console.log("❌ Tenant not found.");
        return;
    }

    const tenantDoc = snapshot.docs[0];
    const tenantId = tenantDoc.id;
    const data = tenantDoc.data();

    // The correct remaining amount for this month
    const correctRemaining = data.monthlyPaymentTracking?.remainingAmount || 0;

    console.log(`✅ Found Tenant: ${data.name}`);
    console.log(`   Current Incorrect Global Arrears: KES ${data.arrears}`);
    console.log(`   Correct Remaining Balance: KES ${correctRemaining}`);

    // Fix the database
    await updateDoc(doc(db, 'tenants', tenantId), {
        arrears: correctRemaining,
        financialSummary: {
            totalPaid: data.financialSummary?.totalPaid || 0,
            arrears: correctRemaining,
            balance: -correctRemaining
        }
    });

    console.log("🎉 Database fixed! The Global Arrears now correctly match the 1-month remaining balance.");
}

fixTenantArrears();
