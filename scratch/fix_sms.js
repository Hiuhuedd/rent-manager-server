const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'smsService.js');
let content = fs.readFileSync(filePath, 'utf8');

// Find and replace the broken block
const brokenBlock = `    const message = \`Hello \${tenantData.name}, \` +
      \`Outstanding deposit for Unit \${tenantData.unitCode}: KSH \${formatAmount(tenantData.depositAmount)}. \` +
          const formatPhoneAsAccount = (phone) => {
      if (!phone) return 'Tenant Phone';
      let clean = phone.trim().replace(/\\s+/g, '').replace(/\\+/g, '');
      if (clean.startsWith('254')) {
        clean = '0' + clean.substring(3);
      }
      if (!clean.startsWith('0') && clean.length >= 9) {
        clean = '0' + clean;
      }
      return clean;
    };

    const message = \`Hello \${tenantData.name}, \` +
      \`Outstanding deposit for Unit \${tenantData.unitCode}: KSH \${formatAmount(tenantData.depositAmount)}. \` +
      \`Pay: Paybill \${paymentInfo.paybill}, Acc \${formatPhoneAsAccount(paymentInfo.accountNumber)}.\`;`;

const correctBlock = `    const formatPhoneAsAccount = (phone) => {
      if (!phone) return 'Tenant Phone';
      let clean = phone.trim().replace(/\\s+/g, '').replace(/\\+/g, '');
      if (clean.startsWith('254')) {
        clean = '0' + clean.substring(3);
      }
      if (!clean.startsWith('0') && clean.length >= 9) {
        clean = '0' + clean;
      }
      return clean;
    };

    const message = \`Hello \${tenantData.name}, \` +
      \`Outstanding deposit for Unit \${tenantData.unitCode}: KSH \${formatAmount(tenantData.depositAmount)}. \` +
      \`Pay: Paybill \${paymentInfo.paybill}, Acc \${formatPhoneAsAccount(paymentInfo.accountNumber)}.\`;`;

// Normalize newlines to do matching
const normalizedContent = content.replace(/\r\n/g, '\n');
const normalizedBroken = brokenBlock.replace(/\r\n/g, '\n');
const normalizedCorrect = correctBlock.replace(/\r\n/g, '\n');

if (normalizedContent.includes(normalizedBroken)) {
  console.log('✅ Found the broken block. Replacing...');
  const newContent = normalizedContent.replace(normalizedBroken, normalizedCorrect);
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log('🎉 Successfully fixed smsService.js!');
} else {
  console.log('❌ Broken block not found. Checking alternate match...');
  // Let's print a small chunk to see what's in the file
  const lines = normalizedContent.split('\n');
  console.log('Lines 125-150:');
  for (let i = 125; i < 150; i++) {
    console.log(`${i + 1}: ${lines[i]}`);
  }
}
