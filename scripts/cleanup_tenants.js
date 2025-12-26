require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') }); // Load env from parent dir
const { getFirestore, collection, getDocs, updateDoc, doc, setDoc } = require('firebase/firestore');
const { initializeApp } = require('firebase/app');

// Re-using config from firebase.js logic but inline to ensure environment loading works
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

console.log('Using project:', firebaseConfig.projectId);
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const cleanupTenants = async () => {
    console.log('🔄 Starting tenant cleanup...');
    const tenantsRef = collection(db, 'tenants');
    const snapshot = await getDocs(tenantsRef);
    let updatedCount = 0;

    // Helper to deeply remove null/undefined
    const cleanObject = (obj) => {
        if (obj === null || obj === undefined) return undefined;
        if (Object.prototype.toString.call(obj) !== '[object Object]') return obj;

        const newObj = {};
        for (const key in obj) {
            const value = cleanObject(obj[key]);
            if (value !== undefined && value !== null) {
                newObj[key] = value;
            }
        }
        return newObj;
    };

    for (const tenantDoc of snapshot.docs) {
        const data = tenantDoc.data();
        const cleanedData = cleanObject(data);

        // Simple string comparison to see if anything changed
        if (JSON.stringify(cleanedData) !== JSON.stringify(data)) {
            try {
                // Determine if we need to remove fields or just overwrite
                // For Firestore Web SDK, setDoc with merge:false overwrites cleanly
                await setDoc(doc(db, 'tenants', tenantDoc.id), cleanedData);
                console.log(`✅ Cleaned tenant: ${tenantDoc.id}`);
                updatedCount++;
            } catch (err) {
                console.error(`❌ Failed to update ${tenantDoc.id}:`, err.message);
            }
        }
    }

    console.log(`🎉 Cleanup complete. Updated ${updatedCount} tenants.`);
    process.exit(0);
};

cleanupTenants().catch(e => {
    console.error(e);
    process.exit(1);
});
