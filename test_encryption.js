const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

try {
  const certPath = path.resolve(__dirname, 'ProductionCertificate.cer');
  const pubKey = fs.readFileSync(certPath, 'utf8');
  
  const buffer = Buffer.from('testpassword');
  const encrypted = crypto.publicEncrypt({
    key: pubKey,
    padding: crypto.constants.RSA_PKCS1_PADDING
  }, buffer);
  
  console.log("Success:", encrypted.toString('base64').substring(0, 50) + "...");
} catch (e) {
  console.error("Error:", e.message);
}
