const crypto = require('crypto');

const SECRET_KEY_STRING = process.env.ENCRYPTION_KEY || 'kodi_default_secret_key_32_bytes!';
// Derive a 32-byte key using SHA-256 to match the frontend
const key = crypto.createHash('sha256').update(SECRET_KEY_STRING).digest();

function encryptData(text) {
    if (!text || typeof text !== 'string') return text;
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        
        let encrypted = cipher.update(text, 'utf8');
        encrypted = Buffer.concat([encrypted, cipher.final()]);
        
        const authTag = cipher.getAuthTag();
        const combined = Buffer.concat([iv, encrypted, authTag]);
        
        return combined.toString('base64');
    } catch (e) {
        console.error('Encryption failed:', e.message);
        return text;
    }
}

function decryptData(encryptedBase64) {
    if (!encryptedBase64 || typeof encryptedBase64 !== 'string') return encryptedBase64;
    // Basic check if it looks like base64
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encryptedBase64) || encryptedBase64.length < 28) {
        return encryptedBase64;
    }

    try {
        const buffer = Buffer.from(encryptedBase64, 'base64');
        const iv = buffer.slice(0, 12);
        const authTag = buffer.slice(buffer.length - 16);
        const encryptedText = buffer.slice(12, buffer.length - 16);
        
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encryptedText);
        decrypted = Buffer.concat([decrypted, decipher.final()]);
        
        return decrypted.toString('utf8');
    } catch (e) {
        // If decryption fails, it might be an unencrypted plain string (fallback)
        return encryptedBase64;
    }
}

module.exports = { encryptData, decryptData };
