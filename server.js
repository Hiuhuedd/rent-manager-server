// const express = require('express');
// const { getFirestoreApp } = require('./firebase');
// const { doc, getDoc } = require('firebase/firestore');
// const smsProcessor = require('./smsProcessor');

// const app = express();
// const db = getFirestoreApp();

// app.use(express.json());

// // Standardized error response helper
// const createErrorResponse = (status, message, details = {}, originalData = null) => ({
//   success: false,
//   error: {
//     message,
//     code: status,
//     details: process.env.NODE_ENV === 'development' ? details : undefined,
//     originalData
//   }
// });

// // POST /webhook - Receive and process M-Pesa SMS for rental payments
// app.post('/webhook', async (req, res) => {
//   try {
//     console.log('📥 Received SMS webhook:', JSON.stringify(req.body, null, 2));

//     // Extract webhook data
//     const webhookData = req.body;

//     // Validate webhook data
//     if (!webhookData || !webhookData.body) {
//       console.error('❌ No SMS message provided in request body');
//       return res.status(400).json(createErrorResponse(400, 'SMS message is required', { receivedBody: req.body }));
//     }

//     // Parse the SMS using smsProcessor
//     const parsedSMS = smsProcessor.parseMpesaWebhook(webhookData);

//     if (!parsedSMS.success) {
//       console.warn('⚠️ Failed to parse SMS:', parsedSMS.error);
//       return res.status(400).json(createErrorResponse(400, 'Invalid SMS message format', { error: parsedSMS.error }, webhookData.body));
//     }

//     const { transactionId } = parsedSMS.data;

//     // Check if transaction exists in Firestore 'rental_payments' collection
//     const paymentRef = doc(db, 'rental_payments', transactionId);
//     const paymentSnap = await getDoc(paymentRef);

//     if (paymentSnap.exists()) {
//       console.warn(`⚠️ Transaction ${transactionId} already exists`);
//       return res.status(409).json(createErrorResponse(409, `Transaction ${transactionId} already processed`, { transactionId }));
//     }

//     // Process the payment (validate house and store payment)
//     const paymentResult = await smsProcessor.processRentalPayment(parsedSMS.data);

//     if (!paymentResult.success) {
//       console.error('❌ Failed to process rental payment:', paymentResult.error);
//       return res.status(400).json(createErrorResponse(400, 'Payment processing failed', { error: paymentResult.error, houseNumber: parsedSMS.data.accountNumber }));
//     }

//     console.log('✅ Webhook processed successfully:', JSON.stringify(paymentResult, null, 2));
//     res.status(200).json({
//       success: true,
//       message: 'Rental payment processed successfully',
//       payment: paymentResult
//     });

//   } catch (error) {
//     console.error('❌ Webhook error:', error.message, error.stack);
//     res.status(500).json(createErrorResponse(500, 'Internal server error', { stack: error.stack }, req.body));
//   }
// });

// const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => {
//   console.log(`🚀 Server running on port ${PORT}`);
// });
const express = require('express');
const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, getDocs, query, where, addDoc, updateDoc, writeBatch } = require('firebase/firestore');
const smsProcessor = require('./smsProcessor');
const SMSService = require('./smsService');

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

// POST /webhook - Process M-Pesa SMS
app.post('/webhook', async (req, res) => {
  try {
    console.log('📥 Received SMS webhook:', JSON.stringify(req.body, null, 2));
    const webhookData = req.body;

    if (!webhookData || !webhookData.body) {
      console.error('❌ No SMS message provided in request body');
      return res.status(400).json(createErrorResponse(400, 'SMS message is required', { receivedBody: req.body }));
    }

    const parsedSMS = smsProcessor.parseMpesaWebhook(webhookData);
    if (!parsedSMS.success) {
      console.warn('⚠️ Failed to parse SMS:', parsedSMS.error);
      return res.status(400).json(createErrorResponse(400, 'Invalid SMS message format', { error: parsedSMS.error }, webhookData.body));
    }

    const { transactionId } = parsedSMS.data;
    const paymentRef = doc(db, 'rental_payments', transactionId);
    const paymentSnap = await getDoc(paymentRef);

    if (paymentSnap.exists()) {
      console.warn(`⚠️ Transaction ${transactionId} already exists`);
      return res.status(409).json(createErrorResponse(409, `Transaction ${transactionId} already processed`, { transactionId }));
    }

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

// GET /properties - List all properties
app.get('/properties', async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, 'properties'));
    const properties = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(properties);
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching properties', { error: error.message }));
  }
});

// GET /properties/:id/units - List units for a property
app.get('/properties/:id/units', async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, 'properties', req.params.id, 'units'));
    const units = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(units);
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching units', { error: error.message }));
  }
});

// ----------------------------------------------------
//  /properties – FULLY LOGGED ENDPOINT
// ----------------------------------------------------
app.post('/properties', async (req, res) => {
  const start = Date.now();                         // 1. Request start time
  const ip = req.ip || req.connection.remoteAddress; // 2. Client IP

  // 3. Full request payload (deep-cloned so we can redact later if needed)
  const payload = JSON.parse(JSON.stringify(req.body));

  console.log('\n=== NEW /properties REQUEST ===');
  console.log(`Time      : ${new Date().toISOString()}`);
  console.log(`IP        : ${ip}`);
  console.log(`Method    : ${req.method}`);
  console.log(`URL       : ${req.originalUrl}`);
  console.log(`Headers   :`, req.headers);
  console.log(`Payload   :`, JSON.stringify(payload, null, 2));

  try {
    // ------------------------------------------------
    // 4. Input validation (with detailed error log)
    // ------------------------------------------------
    const { name, units } = payload;
    if (!name || typeof name !== 'string') {
      console.warn('Validation failed – missing or invalid "name"');
      return res.status(400).json({ error: 'Property name is required and must be a string' });
    }
    if (!Array.isArray(units) || units.length === 0) {
      console.warn('Validation failed – "units" must be a non-empty array');
      return res.status(400).json({ error: 'Units array is required and cannot be empty' });
    }

    // ------------------------------------------------
    // 5. Firestore write – log each batch step
    // ------------------------------------------------
    console.log(`Adding property "${name}" …`);
    const propertyRef = await addDoc(collection(db, 'properties'), { name });
    const propertyId = propertyRef.id;
    console.log(`Property document created – ID: ${propertyId}`);

    // ---- Units batch ----
    const unitBatch = writeBatch(db);
    units.forEach((unit, idx) => {
      const unitRef = doc(collection(db, 'properties', propertyId, 'units'));
      unitBatch.set(unitRef, { ...unit, propertyId });
      console.log(`  • Unit[${idx}] → ${unit.code} (rent: ${unit.rent})`);
    });
    await unitBatch.commit();
    console.log(`Units batch committed (${units.length} docs)`);

    // ---- Tenants batch ----
    const tenantBatch = writeBatch(db);
    units.forEach((unit, idx) => {
      const tenantRef = doc(collection(db, 'tenants'));
      tenantBatch.set(tenantRef, {
        name: '',
        unitCode: unit.code,
        phone: '',
        arrears: unit.rent || 0,
        propertyId,
      });
      console.log(`  • Tenant[${idx}] → unit ${unit.code}`);
    });
    await tenantBatch.commit();
    console.log(`Tenants batch committed (${units.length} docs)`);

    // ------------------------------------------------
    // 6. Success response + timing
    // ------------------------------------------------
    const duration = Date.now() - start;
    console.log(`Success – total time: ${duration} ms`);
    console.log('=== END REQUEST ===\n');

    res.json({
      success: true,
      message: 'Property added',
      id: propertyId,
      durationMs: duration,
    });
  } catch (error) {
    // ------------------------------------------------
    // 7. Error handling – full stack + context
    // ------------------------------------------------
    const duration = Date.now() - start;
    console.error(`ERROR after ${duration} ms`);
    console.error('Stack:', error.stack || error);
    console.error('=== END REQUEST (FAILED) ===\n');

    res.status(500).json({
      error: 'Server error while adding property',
      message: error.message,
      code: error.code || 'UNKNOWN',
    });
  }
});

// GET /tenants - List all tenants
app.get('/tenants', async (req, res) => {
  try {
    const snapshot = await getDocs(collection(db, 'tenants'));
    const tenants = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(tenants);
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching tenants', { error: error.message }));
  }
});

// GET /tenants/:id - Get tenant details
app.get('/tenants/:id', async (req, res) => {
  try {
    const tenantRef = doc(db, 'tenants', req.params.id);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) {
      return res.status(404).json(createErrorResponse(404, 'Tenant not found'));
    }
    res.json({ id: tenantSnap.id, ...tenantSnap.data() });
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching tenant', { error: error.message }));
  }
});

// POST /tenants - Add or update a tenant
app.post('/tenants', async (req, res) => {
  try {
    const { id, name, unitCode, phone } = req.body;
    if (!unitCode || !name || !phone) {
      return res.status(400).json(createErrorResponse(400, 'Name, unitCode, and phone are required'));
    }

    // Verify unit exists
    const unitsQuery = query(collection(db, 'units'), where('code', '==', unitCode));
    const unitsSnapshot = await getDocs(unitsQuery);
    if (unitsSnapshot.empty) {
      return res.status(400).json(createErrorResponse(400, `Unit ${unitCode} not found`));
    }
    const unit = unitsSnapshot.docs[0].data();

    const tenantData = { name, unitCode, phone, propertyId: unit.propertyId, arrears: unit.rent };
    let tenantId;
    if (id) {
      // Update existing tenant
      await updateDoc(doc(db, 'tenants', id), tenantData);
      tenantId = id;
    } else {
      // Create new tenant
      const tenantRef = await addDoc(collection(db, 'tenants'), tenantData);
      tenantId = tenantRef.id;
    }

    res.json({ success: true, message: 'Tenant saved', id: tenantId });
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error saving tenant', { error: error.message }));
  }
});

// GET /payments/status - Payment status per unit per month
app.get('/payments/status', async (req, res) => {
  try {
    const paymentsSnapshot = await getDocs(collection(db, 'rental_payments'));
    const unitsSnapshot = await getDocs(collection(db, 'units'));
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));

    const units = unitsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const tenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const payments = paymentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const status = [];
    units.forEach(unit => {
      const tenant = tenants.find(t => t.unitCode === unit.code);
      const unitPayments = payments.filter(p => p.unitId === unit.id);
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      const payment = unitPayments.find(p => p.date.slice(0, 7) === currentMonth);

      status.push({
        unitCode: unit.code,
        month: currentMonth,
        status: payment ? 'Paid' : 'Unpaid',
        amount: payment ? payment.amount : 0,
        tenant: tenant ? tenant.name : 'Vacant',
      });
    });

    res.json(status);
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching payment status', { error: error.message }));
  }
});

// GET /payments/volume - Payment volume per property (monthly/yearly)
app.get('/payments/volume', async (req, res) => {
  try {
    const paymentsSnapshot = await getDocs(collection(db, 'rental_payments'));
    const propertiesSnapshot = await getDocs(collection(db, 'properties'));

    const payments = paymentsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const properties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const volume = [];
    properties.forEach(property => {
      const propertyPayments = payments.filter(p => p.propertyId === property.id);
      const byMonth = {};
      propertyPayments.forEach(p => {
        const month = p.date.slice(0, 7); // YYYY-MM
        byMonth[month] = (byMonth[month] || 0) + p.amount;
      });

      Object.entries(byMonth).forEach(([month, total]) => {
        volume.push({
          property: property.name,
          month,
          total,
        });
      });

      const byYear = {};
      propertyPayments.forEach(p => {
        const year = p.date.slice(0, 4); // YYYY
        byYear[year] = (byYear[year] || 0) + p.amount;
      });

      Object.entries(byYear).forEach(([year, total]) => {
        volume.push({
          property: property.name,
          year,
          total,
        });
      });
    });

    res.json(volume);
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching payment volume', { error: error.message }));
  }
});

// GET /arrears - Arrears per tenant and total per property
app.get('/arrears', async (req, res) => {
  try {
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const propertiesSnapshot = await getDocs(collection(db, 'properties'));

    const tenants = tenantsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const properties = propertiesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const arrears = tenants
      .filter(t => t.arrears > 0)
      .map(t => ({
        tenant: t.name,
        unitCode: t.unitCode,
        amount: t.arrears,
        propertyId: t.propertyId,
      }));

    const totalByProperty = {};
    properties.forEach(p => {
      totalByProperty[p.id] = {
        property: p.name,
        totalArrears: arrears
          .filter(a => a.propertyId === p.id)
          .reduce((sum, a) => sum + a.amount, 0),
      };
    });

    res.json([...arrears, ...Object.values(totalByProperty)]);
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching arrears', { error: error.message }));
  }
});

// POST /tenants/:id/send-reminder - Send SMS reminder
app.post('/tenants/:id/send-reminder', async (req, res) => {
  try {
    const tenantRef = doc(db, 'tenants', req.params.id);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) {
      return res.status(404).json(createErrorResponse(404, 'Tenant not found'));
    }
    const tenant = tenantSnap.data();

    if (!tenant.arrears || tenant.arrears <= 0) {
      return res.status(400).json(createErrorResponse(400, 'No arrears for this tenant'));
    }

    const debt = {
      debtCode: tenant.unitCode,
      storeOwner: { name: tenant.name },
      remainingAmount: tenant.arrears,
      paymentMethod: 'mpesa',
      dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // Due in 7 days
    };

    const smsMessage = SMSService.generateInvoiceSMS(debt, tenant.phone);
    const smsResult = await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, tenant.unitCode);

    if (!smsResult.success) {
      return res.status(500).json(createErrorResponse(500, 'Failed to send SMS', { error: smsResult.error }));
    }

    res.json({ success: true, message: 'Reminder sent', messageId: smsResult.messageId });
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error sending reminder', { error: error.message }));
  }
});

// POST /tenants/:id/send-confirmation - Send payment confirmation SMS (manual trigger)
app.post('/tenants/:id/send-confirmation', async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) {
      return res.status(400).json(createErrorResponse(400, 'Valid payment amount required'));
    }

    const tenantRef = doc(db, 'tenants', req.params.id);
    const tenantSnap = await getDoc(tenantRef);
    if (!tenantSnap.exists()) {
      return res.status(404).json(createErrorResponse(404, 'Tenant not found'));
    }
    const tenant = tenantSnap.data();

    const debt = {
      debtCode: tenant.unitCode,
      storeOwner: { name: tenant.name },
      remainingAmount: tenant.arrears || 0,
    };

    const smsMessage = SMSService.generatePaymentConfirmationSMS(debt, amount);
    const smsResult = await SMSService.sendSMS(tenant.phone, smsMessage, tenant.id, tenant.unitCode);

    if (!smsResult.success) {
      return res.status(500).json(createErrorResponse(500, 'Failed to send SMS', { error: smsResult.error }));
    }

    // Update arrears
    const newArrears = Math.max(0, tenant.arrears - amount);
    await updateDoc(tenantRef, { arrears: newArrears });

    res.json({ success: true, message: 'Confirmation sent', messageId: smsResult.messageId });
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error sending confirmation', { error: error.message }));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});