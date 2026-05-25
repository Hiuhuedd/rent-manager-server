const axios = require('axios');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

async function registerUrls() {
    console.log("==========================================");
    console.log("🚀 KODIPAY DARAJA URL REGISTRATION UTILITY");
    console.log("==========================================\n");

    // Pull settings from .env
    const isProd = process.env.KODIPAY_MASTER_ENV === 'production';
    const baseUrl = isProd ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

    const consumerKey = process.env.KODIPAY_MASTER_CONSUMER_KEY;
    const consumerSecret = process.env.KODIPAY_MASTER_CONSUMER_SECRET;
    const shortCode = process.env.KODIPAY_MASTER_SHORTCODE;

    if (!consumerKey || !consumerSecret || !shortCode) {
        console.error("❌ ERROR: Missing KODIPAY_MASTER credentials in your .env file.");
        console.log("Please ensure KODIPAY_MASTER_CONSUMER_KEY, SECRET, and SHORTCODE are set.");
        return;
    }

    console.log(`🌍 Environment: ${isProd ? 'PRODUCTION' : 'SANDBOX'} (${baseUrl})`);
    console.log(`🏢 ShortCode:  ${shortCode}`);
    console.log(`🔐 Authenticating...`);

    try {
        // 1. Get Access Token
        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
        const tokenResponse = await axios.get(`${baseUrl}/oauth/v2/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${auth}` }
        });
        const accessToken = tokenResponse.data.access_token;
        console.log(`✅ Token Generated Successfully.`);

        // 2. Register URLs
        console.log(`\n🔗 Registering Webhook Listener Endpoints...`);

        const payload = {
            ShortCode: shortCode,
            ResponseType: 'Completed', // 'Completed' means if KodiPay server times out, Daraja completes the transaction anyway
            ConfirmationURL: 'https://rent-manager-server.onrender.com/api/webhook/gateway/confirmation',
            ValidationURL: 'https://rent-manager-server.onrender.com/api/webhook/gateway/validation'
        };

        const registerResponse = await axios.post(`${baseUrl}/mpesa/c2b/v2/registerurl`, payload, {
            headers: { Authorization: `Bearer ${accessToken}` }
        });

        console.log("\n✅ REGISTRATION SUCCESSFUL!");
        console.log(registerResponse.data);
        console.log("\nDaraja will now forward all payments to your Render server!");

    } catch (error) {
        console.error("\n❌ SCRIPT FAILED:");
        if (error.response) {
            console.error(`Status Code: ${error.response.status}`);
            console.error("Response Data:", JSON.stringify(error.response.data, null, 2));
        } else {
            console.error("Error Message:", error.message);
            console.error("Full Error:", error);
        }
    }
}

registerUrls();
