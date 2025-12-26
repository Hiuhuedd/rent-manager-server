const { db } = require('./config/firebase');
const { collection, getDocs, limit, query } = require('firebase/firestore');

async function checkTenants() {
    try {
        const snapshot = await getDocs(query(collection(db, 'tenants'), limit(3)));
        const tenants = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            console.log(`\nTenant ID: ${doc.id}`);
            console.log('Keys:', Object.keys(data).join(', '));
            console.log('Unit ID:', data.unitId);
            console.log('Unit Name:', data.unitName);
            console.log('Unit Code:', data.unitCode);
        });
    } catch (error) {
        console.error('Error:', error);
    }
}

checkTenants();
