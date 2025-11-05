// const { getFirestoreApp } = require('./firebase');
// const { collection, query, where, getDocs, doc, setDoc, limit } = require('firebase/firestore');

// class SMSProcessor {
//   constructor() {
//     this.db = getFirestoreApp();
//   }

//   // Parse M-Pesa SMS webhook
//   parseMpesaWebhook(webhookData) {
//     try {
//       console.log('Received webhook data:', webhookData);
//       const rawMessage = webhookData?.body || null;
//       if (!rawMessage || typeof rawMessage !== 'string') {
//         throw new Error('No SMS message provided in request body or invalid format');
//       }
//       // Remove any "From: MPESA()" prefix if present
//       const smsMessage = rawMessage.replace(/^From\s*:\s*MPESA\(\)\n?/, '').trim();
//       return this.parseMpesaSMS(smsMessage);
//     } catch (error) {
//       console.error('Error parsing webhook SMS message:', error);
//       return { success: false, error: error.message, originalMessage: webhookData?.body || null };
//     }
//   }

//   // Parse M-Pesa SMS message
//   parseMpesaSMS(smsMessage) {
//     try {
//       console.log('Parsing SMS message:', smsMessage);
//       if (!smsMessage || typeof smsMessage !== 'string') {
//         throw new Error('No SMS message provided or invalid format');
//       }

//       const patterns = {
//         payment: {
//           transactionId: /^([A-Z0-9]+)\s+Confirmed/,
//           amount: /Ksh([\d,]+\.?\d*)\s+received/,
//           accountNumber: /Account Number\s+([A-Z0-9]+)/,
//           phoneNumber: /(\d{12})/,
//           datetime: /on\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+at\s+(\d{1,2}:\d{2}\s+(?:AM|PM))/,
//           senderName: /received from\s+([A-Z\s]+)\s+\d{12}/,
//         },
//       };

//       const pattern = patterns.payment;

//       const transactionIdMatch = smsMessage.match(pattern.transactionId);
//       const amountMatch = smsMessage.match(pattern.amount);
//       const accountMatch = smsMessage.match(pattern.accountNumber);
//       const phoneMatch = smsMessage.match(pattern.phoneNumber);
//       const dateTimeMatch = smsMessage.match(pattern.datetime);
//       const senderMatch = smsMessage.match(pattern.senderName);

//       if (!transactionIdMatch || !amountMatch || !accountMatch) {
//         throw new Error('Message does not match payment format');
//       }

//       let transactionDate = null;
//       if (dateTimeMatch) {
//         const [_, date, time] = dateTimeMatch;
//         const [day, month, year] = date.split('/');
//         const fullYear = year.length === 2 ? `20${year}` : year;
//         transactionDate = new Date(
//           `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${time}`
//         );
//       }

//       const parsedData = {
//         messageType: 'payment',
//         transactionId: transactionIdMatch ? transactionIdMatch[1] : null,
//         amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
//         houseNumber: accountMatch ? accountMatch[1] : null,
//         phoneNumber: phoneMatch ? phoneMatch[1] : null,
//         transactionDate: transactionDate || new Date(),
//         senderName: senderMatch ? senderMatch[1].trim() : null,
//         originalMessage: smsMessage,
//       };

//       console.log('Parsed payment SMS data:', parsedData);

//       if (!parsedData.amount || !parsedData.houseNumber) {
//         throw new Error('Missing required fields: amount or house number');
//       }

//       return { success: true, data: parsedData };
//     } catch (error) {
//       console.error('Error parsing SMS message:', error);
//       return { success: false, error: error.message, originalMessage: smsMessage };
//     }
//   }

//   // Process rental payment
//   async processRentalPayment(smsData) {
//     try {
//       console.log('Processing rental payment:', smsData);
//       const { houseNumber, amount, phoneNumber, transactionDate, transactionId, senderName } = smsData;

//       // Check if house exists in Firestore 'houses' collection
//       const housesRef = collection(this.db, 'houses');
//       const houseQuery = query(housesRef, where('houseNumber', '==', houseNumber), limit(1));
//       const houseSnapshot = await getDocs(houseQuery);

//       if (houseSnapshot.empty) {
//         console.error('No house found for houseNumber:', houseNumber);
//         await this.logUnmatchedPayment(smsData, 'No matching house found');
//         return { success: false, error: 'No house found for this house number', houseNumber };
//       }

//       const houseDoc = houseSnapshot.docs[0];
//       const house = { id: houseDoc.id, ...houseDoc.data() };

//       // Create rental payment document
//       const paymentData = {
//         transactionId,
//         houseId: house.id,
//         houseNumber,
//         amount,
//         phoneNumber,
//         senderName,
//         transactionDate,
//         status: 'processed',
//         createdAt: new Date(),
//       };

//       // Store payment in 'rental_payments' collection
//       await setDoc(doc(this.db, 'rental_payments', transactionId), paymentData);
//       console.log(`✅ Created rental payment: ${transactionId} for house ${houseNumber}`);

//       return {
//         success: true,
//         message: 'Rental payment processed successfully',
//         payment: {
//           transactionId,
//           houseId: house.id,
//           houseNumber,
//           amount,
//           phoneNumber,
//           senderName,
//           transactionDate,
//           status: 'processed',
//         },
//       };
//     } catch (error) {
//       console.error('Error processing rental payment:', error);
//       await this.logUnmatchedPayment(smsData, error.message);
//       return { success: false, error: error.message, houseNumber: smsData.houseNumber };
//     }
//   }

//   // Log unmatched payment
//   async logUnmatchedPayment(smsData, reason) {
//     try {
//       await setDoc(doc(this.db, 'unmatched_payments', smsData.transactionId), {
//         ...smsData,
//         reason,
//         needsReview: true,
//         createdAt: new Date(),
//       });
//       console.log('Unmatched payment logged:', smsData.transactionId);
//     } catch (error) {
//       console.error('Error logging unmatched payment:', error);
//     }
//   }
// }

// module.exports = new SMSProcessor();


const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, query, where, getDocs, updateDoc } = require('firebase/firestore');
const SMSService = require('./smsService');

const db = getFirestoreApp();

const parseMpesaWebhook = (webhookData) => {
  try {
    const { body } = webhookData;
    if (!body) throw new Error('No SMS body provided');

    // Example: "TJNEWID0 Confirmed. on 20/9/25 at 12:05 AM Ksh50.00 received from EDWARD KARIUKI HIUHU 254743466032. Account Number R1GF New Utility balance is Ksh1,022,847.00"
    const regex = /(\w+)\s+Confirmed\.\s+on\s+(\d{1,2}\/\d{1,2}\/\d{2}).*Ksh([\d,.]+)\.\d{2}\s+received\s+from\s+([^0-9]+)\s+(\d{10,12}).*Account\s+Number\s+(\w+)/i;
    const match = body.match(regex);

    if (!match) throw new Error('Invalid M-Pesa SMS format');

    const [, transactionId, date, amount, senderName, senderPhone, accountNumber] = match;
    return {
      success: true,
      data: {
        transactionId,
        date: new Date(`20${date}`).toISOString(),
        amount: parseFloat(amount.replace(/,/g, '')),
        senderName: senderName.trim(),
        senderPhone,
        accountNumber,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

const processRentalPayment = async (paymentData) => {
  try {
    const { transactionId, amount, accountNumber } = paymentData;

    // Find unit by accountNumber (unit code)
    const unitsQuery = query(collection(db, 'units'), where('code', '==', accountNumber));
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) {
      return { success: false, error: `Unit ${accountNumber} not found` };
    }

    const unitDoc = unitsSnapshot.docs[0];
    const unit = { id: unitDoc.id, ...unitDoc.data() };
    const propertyRef = doc(db, 'properties', unit.propertyId);

    // Store payment in rental_payments
    const paymentRef = doc(db, 'rental_payments', transactionId);
    await setDoc(paymentRef, {
      ...paymentData,
      unitId: unit.id,
      propertyId: unit.propertyId,
      timestamp: new Date(),
    });

    // Find tenant linked to unit
    const tenantsQuery = query(collection(db, 'tenants'), where('unitCode', '==', accountNumber));
    const tenantsSnapshot = await getDocs(tenantsQuery);

    if (!tenantsSnapshot.empty) {
      const tenantDoc = tenantsSnapshot.docs[0];
      const tenant = { id: tenantDoc.id, ...tenantDoc.data() };

      // Update tenant arrears
      const newArrears = Math.max(0, (tenant.arrears || unit.rent) - amount);
      await updateDoc(doc(db, 'tenants', tenant.id), { arrears: newArrears });

      // Send payment confirmation SMS
      const debt = {
        debtCode: transactionId,
        storeOwner: { name: tenant.name },
        remainingAmount: newArrears,
      };
      const smsMessage = SMSService.generatePaymentConfirmationSMS(debt, amount);
      await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, transactionId);
    }

    return {
      success: true,
      data: {
        transactionId,
        unitId: unit.id,
        propertyId: unit.propertyId,
        amount,
      },
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
};

module.exports = { parseMpesaWebhook, processRentalPayment };