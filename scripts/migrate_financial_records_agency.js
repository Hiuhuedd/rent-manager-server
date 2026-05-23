const { getFirestoreApp } = require('../firebase');
const { collection, getDocs, doc, updateDoc, getDoc } = require('firebase/firestore');

const db = getFirestoreApp();

async function runMigration() {
    console.log("🚀 Starting missing agencyId backfill migration for financial records...");
    try {
        const finRef = collection(db, 'financial_records');
        const finSnap = await getDocs(finRef);
        
        console.log(`📊 Found ${finSnap.docs.length} total financial records. Scanning for missing agencyId...`);
        let updatedCount = 0;
        let skippedCount = 0;

        for (const recordDoc of finSnap.docs) {
            const record = recordDoc.data();
            
            // If agencyId is missing or undefined
            if (!record.agencyId) {
                console.log(`🔍 Record ${recordDoc.id} (${record.transactionId || 'No ID'}) for tenant ${record.tenantName || 'Unknown'} is missing agencyId.`);
                
                let resolvedAgencyId = null;

                if (record.tenantId) {
                    // Try looking up the tenant
                    try {
                        const tenantSnap = await getDoc(doc(db, 'tenants', record.tenantId));
                        if (tenantSnap.exists()) {
                            resolvedAgencyId = tenantSnap.data().agencyId;
                            console.log(`   💡 Found tenant's agencyId: ${resolvedAgencyId}`);
                        }
                    } catch (tenantErr) {
                        console.warn(`   ⚠️ Error fetching tenant ${record.tenantId}:`, tenantErr.message);
                    }
                }

                // Fallback to property check if tenant lookup failed
                if (!resolvedAgencyId && record.propertyId) {
                    try {
                        const propSnap = await getDoc(doc(db, 'properties', record.propertyId));
                        if (propSnap.exists()) {
                            resolvedAgencyId = propSnap.data().agencyId;
                            console.log(`   💡 Found property's agencyId: ${resolvedAgencyId}`);
                        }
                    } catch (propErr) {
                        console.warn(`   ⚠️ Error fetching property ${record.propertyId}:`, propErr.message);
                    }
                }

                // Global fallback if everything else fails
                if (!resolvedAgencyId) {
                    resolvedAgencyId = 'fcZbLipBQxFHv9rCh1y1'; // EH Properties ID from context
                    console.log(`   ⚠️ Could not resolve automatically. Defaulting to agency: ${resolvedAgencyId}`);
                }

                // Update the document
                await updateDoc(doc(db, 'financial_records', recordDoc.id), {
                    agencyId: resolvedAgencyId
                });

                updatedCount++;
                console.log(`   ✅ Backfilled record ${recordDoc.id} with agencyId ${resolvedAgencyId}`);
            } else {
                skippedCount++;
            }
        }

        console.log(`\n🎉 Migration finished:`);
        console.log(`   - Total scanned: ${finSnap.docs.length}`);
        console.log(`   - Backfilled/Updated: ${updatedCount}`);
        console.log(`   - Intact/Skipped: ${skippedCount}`);

    } catch (error) {
        console.error("❌ Migration failed with error:", error);
    }
}

runMigration();
