const axios = require('axios');

async function testApi() {
    const propertyId = 'Hv2AxSMAtxU1QKGqrhGy';
    const month = '2025-12';
    const url = `http://localhost:3000/api/reports/property/${propertyId}/month/${month}`;

    console.log(`Testing API: ${url}`);

    try {
        const res = await axios.get(url);
        console.log('Response Status:', res.status);
        console.log('Response Data:', JSON.stringify(res.data, null, 2));

        const income = res.data?.data?.financials?.income;
        if (income) {
            console.log('\n--- INCOME CHECK ---');
            console.log(`Rent Collected: ${income.total}`);
            console.log(`Transactions: ${income.transactionCount}`);
        } else {
            console.log('Structure mismatch or no data.');
        }

    } catch (err) { //
        console.error('API Error:', err.message);
        if (err.response) {
            console.error('Data:', err.response.data);
            console.error('Status:', err.response.status);
        }
    }
}

testApi();
