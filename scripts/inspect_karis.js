const { db } = require('../config/firebase');
const { collection, getDocs, doc, getDoc } = require('firebase/firestore');

async function inspectKaris() {
    console.log("🔍 Inspecting Karis's tenant details...");
    
    // Find tenant by name
    const tenantsRef = collection(db, 'tenants');
    const tenantsSnap = await getDocs(tenantsRef);
    let karisDoc = null;
    
    tenantsSnap.docs.forEach(d => {
        const data = d.data();
        if (data.name && data.name.toUpperCase().includes('KARIS')) {
            karisDoc = { id: d.id, ...data };
        }
    });

    if (!karisDoc) {
        console.log("❌ Karis not found in 'tenants' collection!");
        return;
    }

    console.log("\n👤 Tenant Document in 'tenants' collection:");
    console.log(JSON.stringify(karisDoc, null, 2));

    // Find monthly reports for Karis
    console.log("\n📊 Inspecting monthly reports for Karis...");
    const reportsRef = collection(db, 'monthly_reports');
    const reportsSnap = await getDocs(reportsRef);
    
    reportsSnap.docs.forEach(d => {
        const data = d.data();
        if (data.tenants) {
            const tenantReport = data.tenants.find(t => t.tenantId === karisDoc.id);
            if (tenantReport) {
                console.log(`\n📅 Report for Month: ${d.id}`);
                console.log(JSON.stringify(tenantReport, null, 2));
            }
        }
    });
}

inspectKaris().catch(console.error);
