const express = require('express');
const { getFirestoreApp } = require('./firebase');
const { doc, getDoc } = require('firebase/firestore');
const smsProcessor = require('./smsProcessor');

const app = express();
const db = getFirestoreApp();

app.use(express.json());

// Standardized error response helper
const createErrorResponse = (status, message, details = {}, originalData = null) => ({
  success: false,
  error: {
    message,
    code: status,
    details: process.env.NODE_ENV === 'development' ? details : undefined,
    originalData
  }
});

// POST /webhook - Receive and process M-Pesa SMS for rental payments
app.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Received SMS webhook:', JSON.stringify(req.body, null, 2));

    // Extract webhook data
    const webhookData = req.body;

    // Validate webhook data
    if (!webhookData || !webhookData.body) {
      console.error('❌ No SMS message provided in request body');
      return res.status(400).json(createErrorResponse(400, 'SMS message is required', { receivedBody: req.body }));
    }

    // Parse the SMS using smsProcessor
    const parsedSMS = smsProcessor.parseMpesaWebhook(webhookData);

    if (!parsedSMS.success) {
      console.warn('⚠️ Failed to parse SMS:', parsedSMS.error);
      return res.status(400).json(createErrorResponse(400, 'Invalid SMS message format', { error: parsedSMS.error }, webhookData.body));
    }

    const { transactionId } = parsedSMS.data;

    // Check if transaction exists in Firestore 'rental_payments' collection
    const paymentRef = doc(db, 'rental_payments', transactionId);
    const paymentSnap = await getDoc(paymentRef);

    if (paymentSnap.exists()) {
      console.warn(`⚠️ Transaction ${transactionId} already exists`);
      return res.status(409).json(createErrorResponse(409, `Transaction ${transactionId} already processed`, { transactionId }));
    }

    // Process the payment (validate house and store payment)
    const paymentResult = await smsProcessor.processRentalPayment(parsedSMS.data);

    if (!paymentResult.success) {
      console.error('❌ Failed to process rental payment:', paymentResult.error);
      return res.status(400).json(createErrorResponse(400, 'Payment processing failed', { error: paymentResult.error, houseNumber: parsedSMS.data.accountNumber }));
    }

    console.log('✅ Webhook processed successfully:', JSON.stringify(paymentResult, null, 2));
    res.status(200).json({
      success: true,
      message: 'Rental payment processed successfully',
      payment: paymentResult
    });

  } catch (error) {
    console.error('❌ Webhook error:', error.message, error.stack);
    res.status(500).json(createErrorResponse(500, 'Internal server error', { stack: error.stack }, req.body));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});