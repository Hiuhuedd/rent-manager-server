const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
const SMSService = require('./smsService');

const db = getFirestoreApp();

const parseMpesaWebhook = (webhookData) => {
  try {
    const { body } = webhookData;
    if (!body) throw new Error('No SMS body provided');

    // Updated regex to match the actual M-Pesa SMS format:
    // "QJ12345TY78 Confirmed. Ksh1,000.00 received from Edward Hiuhu 254743466032 on 23/10/25 at 10:55 AM. Account Number 0743466032..."
    const regex = /(\w+)\s+Confirmed\.\s+Ksh([\d,.]+)\.\d{2}\s+received\s+from\s+([^0-9]+?)\s+(\d{10,12})\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2}).*?Account\s+Number\s+(\w+)/i;
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

    return {
      success: true,
      data: {
        transactionId: transactionId.trim(),
        date: parsedDate.toISOString(),
        amount: parseFloat(amount.replace(/,/g, '')),
        senderName: senderName.trim(),
        senderPhone: senderPhone.trim(),
        accountNumber: accountNumber.trim(),
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const processRentalPayment = async (paymentData) => {
  try {
    const { transactionId, amount, accountNumber, senderPhone } = paymentData;

    // Try to find tenant by unitCode (which matches accountNumber)
    const tenantsByUnitQuery = query(
      collection(db, 'tenants'), 
      where('unitCode', '==', accountNumber)
    );
    const tenantsByUnitSnapshot = await getDocs(tenantsByUnitQuery);

    // Also try to find by phone number as fallback
    const tenantsByPhoneQuery = query(
      collection(db, 'tenants'), 
      where('phone', '==', senderPhone)
    );
    const tenantsByPhoneSnapshot = await getDocs(tenantsByPhoneQuery);

    let tenantDoc = null;
    let tenant = null;

    if (!tenantsByUnitSnapshot.empty) {
      tenantDoc = tenantsByUnitSnapshot.docs[0];
      tenant = { id: tenantDoc.id, ...tenantDoc.data() };
    } else if (!tenantsByPhoneSnapshot.empty) {
      tenantDoc = tenantsByPhoneSnapshot.docs[0];
      tenant = { id: tenantDoc.id, ...tenantDoc.data() };
      console.log(`✅ Found tenant by phone: ${senderPhone}`);
    } else {
      // Log available tenant info for debugging
      console.error(`❌ No tenant found for unitCode: ${accountNumber} or phone: ${senderPhone}`);
      return { 
        success: false, 
        error: `No tenant found for account ${accountNumber} or phone ${senderPhone}` 
      };
    }

    // Store payment in rental_payments
    const paymentRef = doc(db, 'rental_payments', transactionId);
    await setDoc(paymentRef, {
      ...paymentData,
      tenantId: tenant.id,
      unitCode: tenant.unitCode,
      propertyId: tenant.propertyId,
      timestamp: new Date().toISOString(),
      processed: true,
    });

    // Update tenant's financial information
    const currentArrears = tenant.financialSummary?.arrears || tenant.arrears || 0;
    const newArrears = Math.max(0, currentArrears - amount);
    const totalPaid = (tenant.financialSummary?.totalPaid || 0) + amount;

    // Update tenant document
    await updateDoc(doc(db, 'tenants', tenant.id), {
      'financialSummary.arrears': newArrears,
      'financialSummary.totalPaid': totalPaid,
      'financialSummary.lastUpdated': new Date().toISOString(),
      'paymentTimeline.lastPaymentDate': new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Add to payment logs array
      paymentLogs: [
        ...(tenant.paymentLogs || []),
        {
          transactionId,
          amount,
          date: paymentData.date,
          previousArrears: currentArrears,
          newArrears: newArrears,
        }
      ]
    });

    // Send payment confirmation SMS
    const debt = {
      debtCode: transactionId,
      storeOwner: { name: tenant.name },
      remainingAmount: newArrears,
    };
    const smsMessage = SMSService.generatePaymentConfirmationSMS(debt, amount);
    await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, transactionId);

    console.log(`✅ Payment processed: ${transactionId} - Amount: ${amount} - New arrears: ${newArrears}`);

    return {
      success: true,
      data: {
        transactionId,
        tenantId: tenant.id,
        unitCode: tenant.unitCode,
        propertyId: tenant.propertyId,
        amount,
        previousArrears: currentArrears,
        newArrears,
      },
    };
  } catch (error) {
    console.error('❌ Error processing rental payment:', error);
    return { success: false, error: error.message };
  }
};

module.exports = { parseMpesaWebhook, processRentalPayment };