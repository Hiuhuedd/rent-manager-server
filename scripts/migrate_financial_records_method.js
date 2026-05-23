const { getFirestoreApp } = require('../firebase');
const { collection, getDocs, doc, updateDoc } = require('firebase/firestore');

const db = getFirestoreApp();

// Standard M-Pesa transaction reference pattern (10 alphanumeric capital characters, starting with letters)
const mpesaCodePattern = /^[A-Z0-9]{10}$/;

async function runMigration() {
    console.log("🚀 Starting paymentMethod & source backfill migration for financial records...");
    try {
        const finRef = collection(db, 'financial_records');
        const finSnap = await getDocs(finRef);
        
        console.log(`📊 Found ${finSnap.docs.length} total financial records. Scanning for M-Pesa codes...`);
        let updatedCount = 0;
        let skippedCount = 0;

        for (const recordDoc of finSnap.docs) {
            const record = recordDoc.data();
            const txId = record.transactionId || '';

            // Check if transaction ID matches M-Pesa pattern (e.g. "UEJK950CR8")
            const isMpesaTx = mpesaCodePattern.test(txId) && !txId.startsWith('MANUAL') && !txId.startsWith('EXCESS');

            if (isMpesaTx && (!record.paymentMethod || record.paymentMethod === 'other' || record.paymentMethod === 'manual')) {
                console.log(`🔍 Record ${recordDoc.id} (${txId}) for tenant ${record.tenantName || 'Unknown'} matches M-Pesa code pattern.`);
                
                // Update the document
                await updateDoc(doc(db, 'financial_records', recordDoc.id), {
                    paymentMethod: 'mpesa',
                    source: 'M-Pesa SMS'
                });

                updatedCount++;
                console.log(`   ✅ Backfilled record ${recordDoc.id} with paymentMethod: 'mpesa' and source: 'M-Pesa SMS'`);
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
