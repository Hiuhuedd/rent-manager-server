const { getFirestoreApp } = require('./firebase');
const { collection, query, where, getDocs, doc, setDoc, limit } = require('firebase/firestore');

class SMSProcessor {
  constructor() {
    this.db = getFirestoreApp();
  }

  // Parse M-Pesa SMS webhook
  parseMpesaWebhook(webhookData) {
    try {
      console.log('Received webhook data:', webhookData);
      const rawMessage = webhookData?.body || null;
      if (!rawMessage || typeof rawMessage !== 'string') {
        throw new Error('No SMS message provided in request body or invalid format');
      }
      // Remove any "From: MPESA()" prefix if present
      const smsMessage = rawMessage.replace(/^From\s*:\s*MPESA\(\)\n?/, '').trim();
      return this.parseMpesaSMS(smsMessage);
    } catch (error) {
      console.error('Error parsing webhook SMS message:', error);
      return { success: false, error: error.message, originalMessage: webhookData?.body || null };
    }
  }

  // Parse M-Pesa SMS message
  parseMpesaSMS(smsMessage) {
    try {
      console.log('Parsing SMS message:', smsMessage);
      if (!smsMessage || typeof smsMessage !== 'string') {
        throw new Error('No SMS message provided or invalid format');
      }

      const patterns = {
        payment: {
          transactionId: /^([A-Z0-9]+)\s+Confirmed/,
          amount: /Ksh([\d,]+\.?\d*)\s+received/,
          accountNumber: /Account Number\s+([A-Z0-9]+)/,
          phoneNumber: /(\d{12})/,
          datetime: /on\s+(\d{1,2}\/\d{1,2}\/\d{2})\s+at\s+(\d{1,2}:\d{2}\s+(?:AM|PM))/,
          senderName: /received from\s+([A-Z\s]+)\s+\d{12}/,
        },
      };

      const pattern = patterns.payment;

      const transactionIdMatch = smsMessage.match(pattern.transactionId);
      const amountMatch = smsMessage.match(pattern.amount);
      const accountMatch = smsMessage.match(pattern.accountNumber);
      const phoneMatch = smsMessage.match(pattern.phoneNumber);
      const dateTimeMatch = smsMessage.match(pattern.datetime);
      const senderMatch = smsMessage.match(pattern.senderName);

      if (!transactionIdMatch || !amountMatch || !accountMatch) {
        throw new Error('Message does not match payment format');
      }

      let transactionDate = null;
      if (dateTimeMatch) {
        const [_, date, time] = dateTimeMatch;
        const [day, month, year] = date.split('/');
        const fullYear = year.length === 2 ? `20${year}` : year;
        transactionDate = new Date(
          `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${time}`
        );
      }

      const parsedData = {
        messageType: 'payment',
        transactionId: transactionIdMatch ? transactionIdMatch[1] : null,
        amount: amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null,
        houseNumber: accountMatch ? accountMatch[1] : null,
        phoneNumber: phoneMatch ? phoneMatch[1] : null,
        transactionDate: transactionDate || new Date(),
        senderName: senderMatch ? senderMatch[1].trim() : null,
        originalMessage: smsMessage,
      };

      console.log('Parsed payment SMS data:', parsedData);

      if (!parsedData.amount || !parsedData.houseNumber) {
        throw new Error('Missing required fields: amount or house number');
      }

      return { success: true, data: parsedData };
    } catch (error) {
      console.error('Error parsing SMS message:', error);
      return { success: false, error: error.message, originalMessage: smsMessage };
    }
  }

  // Process rental payment
  async processRentalPayment(smsData) {
    try {
      console.log('Processing rental payment:', smsData);
      const { houseNumber, amount, phoneNumber, transactionDate, transactionId, senderName } = smsData;

      // Check if house exists in Firestore 'houses' collection
      const housesRef = collection(this.db, 'houses');
      const houseQuery = query(housesRef, where('houseNumber', '==', houseNumber), limit(1));
      const houseSnapshot = await getDocs(houseQuery);

      if (houseSnapshot.empty) {
        console.error('No house found for houseNumber:', houseNumber);
        await this.logUnmatchedPayment(smsData, 'No matching house found');
        return { success: false, error: 'No house found for this house number', houseNumber };
      }

      const houseDoc = houseSnapshot.docs[0];
      const house = { id: houseDoc.id, ...houseDoc.data() };

      // Create rental payment document
      const paymentData = {
        transactionId,
        houseId: house.id,
        houseNumber,
        amount,
        phoneNumber,
        senderName,
        transactionDate,
        status: 'processed',
        createdAt: new Date(),
      };

      // Store payment in 'rental_payments' collection
      await setDoc(doc(this.db, 'rental_payments', transactionId), paymentData);
      console.log(`✅ Created rental payment: ${transactionId} for house ${houseNumber}`);

      return {
        success: true,
        message: 'Rental payment processed successfully',
        payment: {
          transactionId,
          houseId: house.id,
          houseNumber,
          amount,
          phoneNumber,
          senderName,
          transactionDate,
          status: 'processed',
        },
      };
    } catch (error) {
      console.error('Error processing rental payment:', error);
      await this.logUnmatchedPayment(smsData, error.message);
      return { success: false, error: error.message, houseNumber: smsData.houseNumber };
    }
  }

  // Log unmatched payment
  async logUnmatchedPayment(smsData, reason) {
    try {
      await setDoc(doc(this.db, 'unmatched_payments', smsData.transactionId), {
        ...smsData,
        reason,
        needsReview: true,
        createdAt: new Date(),
      });
      console.log('Unmatched payment logged:', smsData.transactionId);
    } catch (error) {
      console.error('Error logging unmatched payment:', error);
    }
  }
}

module.exports = new SMSProcessor();