const { getFirestoreApp } = require('../firebase');
const { collection, getDocs } = require('firebase/firestore');

async function run() {
  const db = getFirestoreApp();

  const collections = ['clients', 'properties', 'financial_records', 'runningCosts', 'payouts'];
  for (const col of collections) {
    console.log(`\n=== COLLECTION: ${col} ===`);
    const snap = await getDocs(collection(db, col));
    snap.docs.forEach(doc => {
      console.log(JSON.stringify({ id: doc.id, ...doc.data() }, null, 2));
    });
  }
}

run().catch(console.error);
