const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
const SMSService = require('./smsService');

const db = getFirestoreApp();

// Normalize phone number to format without country code (0XXXXXXXXX)
const normalizePhoneNumber = (phone) => {
  if (!phone) return '';
  
  // Remove all spaces, dashes, and special characters
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  
  // Remove + if present
  cleaned = cleaned.replace(/^\+/, '');
  
  // If starts with 254 (Kenya country code), remove it and add 0
  if (cleaned.startsWith('254')) {
    cleaned = '0' + cleaned.substring(3);
  }
  
  // If starts with 1 and is 10 digits (0 was removed), add it back
  if (cleaned.length === 9 && /^[17]/.test(cleaned)) {
    cleaned = '0' + cleaned;
  }
  
  return cleaned;
};

const parseMpesaWebhook = (webhookData) => {
  try {
    const { body } = webhookData;
    if (!body) throw new Error('No SMS body provided');

    // Updated regex to match the actual M-Pesa SMS format:
    // "QJ12345TY78 Confirmed. Ksh1,000.00 received from Edward Hiuhu 254743466032 on 23/10/25 at 10:55 AM. Account Number 0743466032..."
    const regex = /(\w+)\s+Confirmed\.\s+Ksh([\d,.]+)\.\d{2}\s+received\s+from\s+([^0-9]+?)\s+(\d{10,12})\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2}).*?Account\s+Number\s+([\w\d]+)/i;
    const match = body.match(regex);

    if (!match) {
      console.error('SMS body:', body);
      throw new Error('Invalid M-Pesa SMS format');
    }

    const [, transactionId, amount, senderName, senderPhone, date, accountNumber] = match;
    
    // Parse date in DD/MM/YY format
    const [day, month, year] = date.split('/');
    const fullYear = parseInt(year) + 2000; // Convert 25 to 2025
    const parsedDate = new Date(fullYear, parseInt(month) - 1, parseInt(day));

    // Normalize phone numbers for consistent matching
    const normalizedSenderPhone = normalizePhoneNumber(senderPhone);
    const normalizedAccountNumber = normalizePhoneNumber(accountNumber);

    return {
      success: true,
      data: {
        transactionId: transactionId.trim(),
        date: parsedDate.toISOString(),
        amount: parseFloat(amount.replace(/,/g, '')),
        senderName: senderName.trim(),
        senderPhone: senderPhone.trim(),
        senderPhoneNormalized: normalizedSenderPhone,
        accountNumber: accountNumber.trim(),
        accountNumberNormalized: normalizedAccountNumber,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const processRentalPayment = async (paymentData) => {
  try {
    const { 
      transactionId, 
      amount, 
      accountNumber, 
      senderPhone,
      senderPhoneNormalized,
      accountNumberNormalized 
    } = paymentData;

    console.log('🔍 Searching for tenant with:');
    console.log('  - Account Number:', accountNumber, '→ Normalized:', accountNumberNormalized);
    console.log('  - Sender Phone:', senderPhone, '→ Normalized:', senderPhoneNormalized);

    // Strategy 1: Search by normalized account number (most common case)
    const tenantsByAccountQuery = query(
      collection(db, 'tenants'), 
      where('phone', '==', accountNumberNormalized)
    );
    const tenantsByAccountSnapshot = await getDocs(tenantsByAccountQuery);

    // Strategy 2: Search by normalized sender phone
    const tenantsByPhoneQuery = query(
      collection(db, 'tenants'), 
      where('phone', '==', senderPhoneNormalized)
    );
    const tenantsByPhoneSnapshot = await getDocs(tenantsByPhoneQuery);

    // Strategy 3: Search by unitCode matching account number
    const tenantsByUnitQuery = query(
      collection(db, 'tenants'), 
      where('unitCode', '==', accountNumber.toUpperCase())
    );
    const tenantsByUnitSnapshot = await getDocs(tenantsByUnitQuery);

    let tenantDoc = null;
    let tenant = null;
    let matchStrategy = '';

    if (!tenantsByAccountSnapshot.empty) {
      tenantDoc = tenantsByAccountSnapshot.docs[0];
      tenant = { id: tenantDoc.id, ...tenantDoc.data() };
      matchStrategy = 'account number';
      console.log(`✅ Found tenant by account number: ${accountNumberNormalized}`);
    } else if (!tenantsByPhoneSnapshot.empty) {
      tenantDoc = tenantsByPhoneSnapshot.docs[0];
      tenant = { id: tenantDoc.id, ...tenantDoc.data() };
      matchStrategy = 'sender phone';
      console.log(`✅ Found tenant by sender phone: ${senderPhoneNormalized}`);
    } else if (!tenantsByUnitSnapshot.empty) {
      tenantDoc = tenantsByUnitSnapshot.docs[0];
      tenant = { id: tenantDoc.id, ...tenantDoc.data() };
      matchStrategy = 'unit code';
      console.log(`✅ Found tenant by unit code: ${accountNumber}`);
    } else {
      // Last resort: Get all tenants and do manual matching
      console.log('🔄 Trying manual phone number matching...');
      const allTenantsSnapshot = await getDocs(collection(db, 'tenants'));
      
      for (const doc of allTenantsSnapshot.docs) {
        const data = doc.data();
        const normalizedTenantPhone = normalizePhoneNumber(data.phone);
        
        if (normalizedTenantPhone === accountNumberNormalized || 
            normalizedTenantPhone === senderPhoneNormalized) {
          tenant = { id: doc.id, ...data };
          matchStrategy = 'manual matching';
          console.log(`✅ Found tenant via manual matching: ${normalizedTenantPhone}`);
          break;
        }
      }
      
      if (!tenant) {
        console.error(`❌ No tenant found after all search strategies`);
        console.error(`   Searched for: ${accountNumberNormalized} and ${senderPhoneNormalized}`);
        return { 
          success: false, 
          error: `No tenant found for account ${accountNumber} or phone ${senderPhone}` 
        };
      }
    }

    // Store payment in rental_payments
    const paymentRef = doc(db, 'rental_payments', transactionId);
    await setDoc(paymentRef, {
      ...paymentData,
      tenantId: tenant.id,
      tenantName: tenant.name,
      unitCode: tenant.unitCode,
      propertyId: tenant.propertyId,
      propertyName: tenant.propertyDetails?.propertyName || '',
      timestamp: new Date().toISOString(),
      processed: true,
      matchStrategy,
    });

    // Update tenant's financial information
    const currentArrears = tenant.financialSummary?.arrears || tenant.arrears || 0;
    const newArrears = Math.max(0, currentArrears - amount);
    const totalPaid = (tenant.financialSummary?.totalPaid || 0) + amount;
    const balance = (tenant.financialSummary?.balance || 0) + amount;

    // Prepare payment log entry
    const paymentLogEntry = {
      transactionId,
      amount,
      date: paymentData.date,
      timestamp: new Date().toISOString(),
      previousArrears: currentArrears,
      newArrears: newArrears,
      senderName: paymentData.senderName,
    };

    // Update tenant document
    await updateDoc(doc(db, 'tenants', tenant.id), {
      'financialSummary.arrears': newArrears,
      'financialSummary.totalPaid': totalPaid,
      'financialSummary.balance': balance,
      'financialSummary.lastUpdated': new Date().toISOString(),
      'paymentTimeline.lastPaymentDate': new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      paymentLogs: [
        ...(tenant.paymentLogs || []),
        paymentLogEntry
      ]
    });

    // Send payment confirmation SMS
    try {
      const debt = {
        debtCode: transactionId,
        storeOwner: { name: tenant.name },
        remainingAmount: newArrears,
      };
      const smsMessage = SMSService.generatePaymentConfirmationSMS(debt, amount);
      await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, transactionId);
      console.log(`📱 SMS confirmation sent to ${tenant.phone}`);
    } catch (smsError) {
      console.error('⚠️ Failed to send SMS confirmation:', smsError.message);
      // Don't fail the whole operation if SMS fails
    }

    console.log(`✅ Payment processed successfully:`);
    console.log(`   Transaction: ${transactionId}`);
    console.log(`   Tenant: ${tenant.name} (${tenant.phone})`);
    console.log(`   Amount: KSh ${amount}`);
    console.log(`   Previous Arrears: KSh ${currentArrears}`);
    console.log(`   New Arrears: KSh ${newArrears}`);
    console.log(`   Match Strategy: ${matchStrategy}`);

    return {
      success: true,
      data: {
        transactionId,
        tenantId: tenant.id,
        tenantName: tenant.name,
        unitCode: tenant.unitCode,
        propertyId: tenant.propertyId,
        amount,
        previousArrears: currentArrears,
        newArrears,
        matchStrategy,
      },
    };
  } catch (error) {
    console.error('❌ Error processing rental payment:', error);
    return { success: false, error: error.message };
  }
};

module.exports = { parseMpesaWebhook, processRentalPayment };