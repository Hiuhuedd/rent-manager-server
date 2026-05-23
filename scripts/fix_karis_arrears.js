const { db } = require('../config/firebase');
const { collection, getDocs, doc, updateDoc } = require('firebase/firestore');

async function fixKarisArrears() {
    console.log("🛠️ Starting database repair for Karis's arrears...");
    
    // Find tenant by name
    const tenantsRef = collection(db, 'tenants');
    const tenantsSnap = await getDocs(tenantsRef);
    let karisId = null;
    
    tenantsSnap.docs.forEach(d => {
        const data = d.data();
        if (data.name && data.name.toUpperCase().includes('KARIS')) {
            karisId = d.id;
        }
    });

    if (!karisId) {
        console.log("❌ Karis not found in 'tenants' collection!");
        return;
    }

    const tenantRef = doc(db, 'tenants', karisId);
    
    // Correct arrears to 50,406 (Expected 50,410 - Paid 4)
    const correctedArrears = 50406;
    const correctedBalance = -50406;

    await updateDoc(tenantRef, {
        arrears: correctedArrears,
        financialSummary: {
            totalPaid: 4,
            arrears: correctedArrears,
            balance: correctedBalance
        }
    });

    console.log(`✅ Successfully repaired Karis's arrears to KES ${correctedArrears.toLocaleString()} and balance to KES ${correctedBalance.toLocaleString()}`);
}

fixKarisArrears().catch(console.error);
