const { getFirestoreApp } = require('./firebase');
const { 
  collection, getDocs, doc, setDoc, 
  writeBatch, query, where 
} = require('firebase/firestore');

const db = getFirestoreApp();

async function migrate() {
  console.log('🚀 Starting Migration to Multi-Tenant Structure...');

  try {
    // 1. Create Default Agency
    const agencyId = 'agency_001';
    const agencyRef = doc(db, 'agencies', agencyId);
    await setDoc(agencyRef, {
      name: 'Primary Agency',
      smsStats: {
        monthlySent: 0,
        monthlyLimit: 2000,
        totalSent: 0,
        lastResetDate: new Date().toISOString()
      },
      createdAt: new Date().toISOString()
    });
    console.log(`✅ Created Agency: ${agencyId}`);

    // 2. Create Admin User (Replace with your actual Firebase UID)
    // You can find this in the Firebase Console under Authentication
    const adminUid = 'ADMIN_UID_HERE'; 
    if (adminUid !== 'ADMIN_UID_HERE') {
      await setDoc(doc(db, 'users', adminUid), {
        uid: adminUid,
        email: 'admin@kodipay.com',
        role: 'admin',
        agencyId: agencyId,
        createdAt: new Date().toISOString()
      });
      console.log(`✅ Created Admin User: ${adminUid}`);
    } else {
      console.warn('⚠️ Skipping Admin user creation. Please update migrate.js with your actual Firebase UID.');
    }

    // 3. Migrate Existing Properties
    console.log('📦 Migrating properties...');
    const propertiesSnap = await getDocs(collection(db, 'properties'));
    const batch = writeBatch(db);
    
    propertiesSnap.forEach(pDoc => {
      if (!pDoc.data().agencyId) {
        batch.update(pDoc.ref, { agencyId: agencyId });
      }
    });

    // 4. Migrate Existing Tenants
    console.log('👥 Migrating tenants...');
    const tenantsSnap = await getDocs(collection(db, 'tenants'));
    tenantsSnap.forEach(tDoc => {
      if (!tDoc.data().agencyId) {
        batch.update(tDoc.ref, { agencyId: agencyId });
      }
    });

    // 5. Migrate Units
    console.log('🏠 Migrating units...');
    const unitsSnap = await getDocs(collection(db, 'units'));
    unitsSnap.forEach(uDoc => {
      if (!uDoc.data().agencyId) {
        batch.update(uDoc.ref, { agencyId: agencyId });
      }
    });

    await batch.commit();
    console.log('🎉 Migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  }
}

migrate();
