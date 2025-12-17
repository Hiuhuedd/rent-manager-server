require('dotenv').config();
const { db } = require('../config/firebase');
const { collection, getDocs, query, where, doc, getDoc } = require('firebase/firestore');
const fs = require('fs');
const util = require('util');

const logFile = fs.createWriteStream('debug_output.txt', { flags: 'w' });
const logStdout = process.stdout;

console.log = function (d) {
    logFile.write(util.format(d) + '\n');
    logStdout.write(util.format(d) + '\n');
};

async function debugFinancials() {
    const month = '2025-12';
    const propertyId = 'Hv2AxSMAtxU1QKGqrhGy';

    console.log('--- DEBUGGING FINANCIAL RECORDS ---');
    console.log(`Target Month: "${month}"`);
    console.log(`Target PropertyId: "${propertyId}"`);

    // 1. Fetch tenants for property
    console.log('\n1. Fetching Property Tenants...');
    const tenantsQuery = query(
        collection(db, 'tenants'),
        where('propertyId', '==', propertyId)
    );
    const tenantsSnap = await getDocs(tenantsQuery);
    console.log(`Found ${tenantsSnap.size} tenants.`);
    const tenantIds = new Set();
    tenantsSnap.forEach(d => {
        tenantIds.add(d.id);
        console.log(` - Tenant: ${d.data().name} (${d.id})`);
    });

    // 2. Fetch ALL records for month
    console.log('\n2. Fetching Financial Records for Month...');
    const paymentsQuery = query(
        collection(db, 'financial_records'),
        where('paymentMonth', '==', month)
    );
    const paymentsSnap = await getDocs(paymentsQuery);
    console.log(`Found ${paymentsSnap.size} total records for month.`);

    // 3. Inspect records
    console.log('\n3. Inspecting Records vs Property...');
    let matchCount = 0;
    paymentsSnap.forEach(d => {
        const data = d.data();
        const propertyMatch = data.propertyId === propertyId;
        const tenantMatch = tenantIds.has(data.tenantId);

        if (propertyMatch || tenantMatch) {
            matchCount++;
            console.log(`\nMATCH FOUND (ID: ${d.id}):`);
            console.log(`- Amount: ${data.amount} (Type: ${typeof data.amount})`);
            console.log(`- PropertyId Match: ${propertyMatch} ("${data.propertyId}")`);
            console.log(`- TenantId Match: ${tenantMatch} ("${data.tenantId}")`);
            console.log(`- Allocation:`, JSON.stringify(data.allocation));
        } else {
            // console.log(`Ignored record for Property: ${data.propertyId}`);
        }
    });

    console.log(`\nTotal Matches for Property: ${matchCount}`);
}

debugFinancials().then(() => {
    logFile.end(() => {
        process.exit();
    });
}).catch(e => {
    console.error(e);
    logFile.end(() => {
        process.exit(1);
    });
});
