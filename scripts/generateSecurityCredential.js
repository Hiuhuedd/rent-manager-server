const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ==========================================
// M-Pesa Security Credential Generator
// ==========================================
// This script encrypts your API Operator plaintext password
// using Safaricom's public certificate.

// 1. Place your Safaricom Public Certificate in the same folder as this script.
//    (Download it from the Daraja portal - usually named SandboxCertificate.cer or ProductionCertificate.cer)
// 2. Change the filename below to match your certificate file.
const CERT_FILE_NAME = 'SandboxCertificate.cer'; 

// 3. Enter your plaintext API Operator password here.
//    (In Sandbox, it's often a test password provided by Safaricom)
const PLAINTEXT_PASSWORD = 'YOUR_API_PASSWORD_HERE';

async function generate() {
    try {
        const certPath = path.join(__dirname, CERT_FILE_NAME);
        
        if (!fs.existsSync(certPath)) {
            console.error(`❌ Certificate not found at: ${certPath}`);
            console.log('Please download the Public Certificate from Daraja and place it in the scripts folder.');
            return;
        }

        const cert = fs.readFileSync(certPath, 'utf8');

        const buffer = Buffer.from(PLAINTEXT_PASSWORD, 'utf8');
        const encrypted = crypto.publicEncrypt({
            key: cert,
            padding: crypto.constants.RSA_PKCS1_PADDING
        }, buffer);

        const securityCredential = encrypted.toString('base64');

        console.log('\n✅ Successfully generated Security Credential!\n');
        console.log('====================================================');
        console.log(securityCredential);
        console.log('====================================================\n');
        console.log('Copy the string above and paste it into your .env file as KODIPAY_MASTER_SECURITY_CREDENTIAL.');

    } catch (err) {
        console.error('❌ Encryption failed:', err.message);
    }
}

generate();
