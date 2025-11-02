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

const cors = require('cors');
app.use(cors({
  origin: true, // Allow all origins in dev
  credentials: true,
}));
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

app.get('/properties/:id', async (req, res) => {
  const start = Date.now();
  const { id } = req.params;

  console.log(`\n=== GET /properties/${id} ===`);
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    // 1. Fetch property document
    const propertyRef = doc(db, 'properties', id);
    const propertySnap = await getDoc(propertyRef);

    if (!propertySnap.exists()) {
      console.log(`[NOT FOUND] Property ID: ${id}`);
      return res.status(404).json({
        success: false,
        error: 'Property not found',
      });
    }

    const propertyData = propertySnap.data();
    console.log(`[FOUND] Property: ${propertyData.propertyName} | Units: ${propertyData.propertyUnitsTotal}`);

    // 2. Fetch all units using propertyUnitIds
    const unitIds = propertyData.propertyUnitIds || [];
    if (unitIds.length === 0) {
      console.log(`[WARN] No unit IDs stored in property`);
    }

    const unitRefs = unitIds.map(uid => doc(db, 'units', uid));
    const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));

    const units = unitSnaps
      .filter(snap => snap.exists())
      .map(snap => {
        const data = snap.data();
        return {
          unitId: data.unitId,
          category: data.category,
          rentAmount: data.rentAmount,
          utilityFees: {
            garbageFee: data.utilityFees?.garbageFee || 0,
            waterBill: data.utilityFees?.waterBill || 0,
          },
          isVacant: data.isVacant,
          tenantId: data.tenantId || null,
        };
      });

    // 3. Recalculate totals (in case of manual edits)
    const recalculatedRevenue = units.reduce((sum, unit) => {
      return sum + unit.rentAmount + unit.utilityFees.garbageFee + unit.utilityFees.waterBill;
    }, 0);

    const vacantCount = units.filter(u => u.isVacant).length;

    // 4. Build final response
    const response = {
      success: true,
      property: {
        propertyId: propertyData.propertyId,
        propertyName: propertyData.propertyName,
        propertyUnitsTotal: units.length,
        propertyRevenueTotal: recalculatedRevenue,
        propertyVacantUnits: vacantCount,
        propertyOccupiedUnits: units.length - vacantCount,
        createdAt: propertyData.createdAt?.toDate?.() || null,
        units,
      },
      queryDurationMs: Date.now() - start,
    };

    console.log(`[SUCCESS] Fetched ${units.length} units | Revenue: KSH ${recalculatedRevenue}`);
    console.log(`Duration: ${response.queryDurationMs} ms`);
    console.log('=== END GET ===\n');

    res.json(response);
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[ERROR] GET /properties/${id} failed after ${duration} ms`);
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);

    res.status(500).json({
      success: false,
      error: 'Failed to fetch property',
      message: error.message,
      code: error.code || 'UNKNOWN',
    });
  }
});
// ----------------------------------------------------
//  /properties – FULLY LOGGED ENDPOINT
// ----------------------------------------------------

app.post('/properties', async (req, res) => {
  const start = Date.now();
  const ip = req.ip || req.connection.remoteAddress;
  const payload = JSON.parse(JSON.stringify(req.body));

  console.log('\n=== NEW /properties REQUEST ===');
  console.log(`Time      : ${new Date().toISOString()}`);
  console.log(`IP        : ${ip}`);
  console.log(`Payload   :`, JSON.stringify(payload, null, 2));

  try {
    const { propertyName, units } = payload;

    // -----------------------------
    // 1. Validate input
    // -----------------------------
    if (!propertyName || typeof propertyName !== 'string') {
      return res.status(400).json({ error: 'Property name is required and must be a string' });
    }
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'Units array is required and cannot be empty' });
    }

    // -----------------------------
    // 2. Initialize batch + property ref
    // -----------------------------
    const batch = writeBatch(db);
    const propertyRef = doc(collection(db, 'properties'));
    const propertyId = propertyRef.id;
    const propertyUnitIds = [];

    let totalRevenue = 0;

    // -----------------------------
    // 3. Create units + calculate revenue
    // -----------------------------
    units.forEach((unit, idx) => {
      const unitId = unit.unitId;
      const unitRef = doc(db, 'units', unitId);
      propertyUnitIds.push(unitId);

      const rent = parseFloat(unit.rentAmount) || 0;
      const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
      const water = parseFloat(unit.utilityFees?.waterBill) || 0;

      const unitTotal = rent + garbage + water;
      totalRevenue += unitTotal;

      const unitData = {
        unitId,
        propertyId,
        isVacant: true,
        category: unit.category || 'Standard',
        rentAmount: rent,
        utilityFees: { garbageFee: garbage, waterBill: water },
      };

      batch.set(unitRef, unitData);
      console.log(`  • Unit[${idx}] → ${unitId} | Rent: ${rent}, Garbage: ${garbage}, Water: ${water} → ${unitTotal}`);
    });

    // -----------------------------
    // 4. Create property document
    // -----------------------------
    const propertyData = {
      propertyId,
      propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: totalRevenue,
      propertyUnitIds,
      propertyVacantUnits: units.length,
    };

    batch.set(propertyRef, propertyData);

    // -----------------------------
    // 5. Commit batch
    // -----------------------------
    await batch.commit();
    const duration = Date.now() - start;

    console.log(`Property "${propertyName}" created with ${units.length} units.`);
    console.log(`Total Revenue: KSH ${totalRevenue}`);
    console.log(`Total time: ${duration} ms`);
    console.log('=== END REQUEST ===\n');

    res.json({
      success: true,
      message: 'Property and units created successfully',
      propertyId,
      totalRevenue,
      durationMs: duration,
    });
  } catch (error) {
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


app.put('/properties/:id', async (req, res) => {
  const start = Date.now();
  const { id } = req.params;
  const payload = req.body;

  console.log(`\n=== PUT /properties/${id} ===`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Payload:`, JSON.stringify(payload, null, 2));

  try {
    const { propertyName, units } = payload;

    // 1. Validate
    if (!propertyName || typeof propertyName !== 'string') {
      return res.status(400).json({ error: 'propertyName is required and must be a string' });
    }
    if (!Array.isArray(units) || units.length === 0) {
      return res.status(400).json({ error: 'units array is required and cannot be empty' });
    }

    // 2. Fetch current property
    const propertyRef = doc(db, 'properties', id);
    const propertySnap = await getDoc(propertyRef);

    if (!propertySnap.exists()) {
      return res.status(404).json({ error: 'Property not found' });
    }

    const currentData = propertySnap.data();
    const currentUnitIds = currentData.propertyUnitIds || [];

    // 3. Validate unit IDs match
    const incomingUnitIds = units.map(u => u.unitId);
    const missing = incomingUnitIds.filter(id => !currentUnitIds.includes(id));
    const extra = currentUnitIds.filter(id => !incomingUnitIds.includes(id));

    if (missing.length > 0 || extra.length > 0) {
      console.log(`[VALIDATION] Unit ID mismatch`);
      console.log(`Missing: ${missing.join(', ')}`);
      console.log(`Extra: ${extra.join(', ')}`);
      return res.status(400).json({
        error: 'Unit IDs do not match stored property. Cannot modify unit list.',
      });
    }

    // 4. Prepare batch
    const batch = writeBatch(db);
    let totalRevenue = 0;
    let vacantCount = 0;

    // 5. Update each unit
    for (const unit of units) {
      const { unitId, rentAmount, utilityFees = {}, isVacant, category } = unit;

      const rent = parseFloat(rentAmount) || 0;
      const garbage = parseFloat(utilityFees.garbageFee) || 0;
      const water = parseFloat(utilityFees.waterBill) || 0;

      const unitTotal = rent + garbage + water;
      totalRevenue += unitTotal;

      if (isVacant === true) vacantCount++;

      const unitRef = doc(db, 'units', unitId);
      batch.set(
        unitRef,
        {
          rentAmount: rent,
          utilityFees: { garbageFee: garbage, waterBill: water },
          isVacant: !!isVacant,
          category: category || 'Standard',
        },
        { merge: true }
      );

      console.log(`  • Updated ${unitId} | Rent: ${rent}, Garbage: ${garbage}, Water: ${water} → ${unitTotal}`);
    }

    // 6. Update property document
    batch.set(
      propertyRef,
      {
        propertyName,
        propertyRevenueTotal: totalRevenue,
        propertyVacantUnits: vacantCount,
        propertyOccupiedUnits: units.length - vacantCount,
        updatedAt: new Date(),
      },
      { merge: true }
    );

    // 7. Commit
    await batch.commit();
    const duration = Date.now() - start;

    console.log(`[SUCCESS] Property "${propertyName}" updated`);
    console.log(`Units: ${units.length} | Revenue: KSH ${totalRevenue} | Vacant: ${vacantCount}`);
    console.log(`Duration: ${duration} ms`);
    console.log('=== END PUT ===\n');

    // 8. Return updated data
    const updatedProperty = {
      propertyId: id,
      propertyName,
      propertyUnitsTotal: units.length,
      propertyRevenueTotal: totalRevenue,
      propertyVacantUnits: vacantCount,
      propertyOccupiedUnits: units.length - vacantCount,
      units: units.map(u => ({
        unitId: u.unitId,
        category: u.category,
        rentAmount: parseFloat(u.rentAmount) || 0,
        utilityFees: {
          garbageFee: parseFloat(u.utilityFees?.garbageFee) || 0,
          waterBill: parseFloat(u.utilityFees?.waterBill) || 0,
        },
        isVacant: !!u.isVacant,
        tenantId: u.tenantId || null,
      })),
    };

    res.json({
      success: true,
      message: 'Property updated successfully',
      property: updatedProperty,
      durationMs: duration,
    });
  } catch (error) {
    const duration = Date.now() - start;
    console.error(`[ERROR] PUT /properties/${id} failed after ${duration} ms`);
    console.error('Message:', error.message);
    console.error('Stack:', error.stack);

    res.status(500).json({
      success: false,
      error: 'Failed to update property',
      message: error.message,
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

    console.log('📥 Incoming tenant data:', { id, name, unitCode, phone });

    if (!unitCode || !name || !phone) {
      console.warn('⚠️ Missing required fields:', { name, unitCode, phone });
      return res
        .status(400)
        .json(createErrorResponse(400, 'Name, unitCode, and phone are required'));
    }

    // Verify unit exists
    console.log('🔍 Checking if unit exists for code:', unitCode);
    const unitsQuery = query(collection(db, 'units'), where('code', '==', unitCode));
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) {
      console.error('❌ Unit not found for code:', unitCode);
      return res.status(400).json(createErrorResponse(400, `Unit ${unitCode} not found`));
    }

    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc.data();
    console.log('✅ Unit found:', unit);

    // Tenant data
    const tenantData = {
      name,
      unitCode,
      phone,
      propertyId: unit.propertyId,
      arrears: unit.rent || 0,
    };

    console.log('🧾 Tenant data to save:', tenantData);

    let tenantId;
    if (id) {
      console.log('✏️ Updating existing tenant with ID:', id);
      await updateDoc(doc(db, 'tenants', id), tenantData);
      tenantId = id;
    } else {
      console.log('➕ Creating new tenant...');
      const tenantRef = await addDoc(collection(db, 'tenants'), tenantData);
      tenantId = tenantRef.id;
    }

    console.log('✅ Tenant saved with ID:', tenantId);

    // 🔄 Update unit with tenant info
    const unitUpdate = {
      tenantId,
      tenantName: name,
      tenantPhone: phone,
      isVacant: false,
    };

    console.log('🧱 Updating unit with tenant info:', unitUpdate);

    await updateDoc(doc(db, 'units', unitDoc.id), unitUpdate);
    console.log('✅ Unit updated successfully');

    res.json({ success: true, message: 'Tenant and unit updated', id: tenantId });
  } catch (error) {
    console.error('💥 Error saving tenant:', error);
    res
      .status(500)
      .json(createErrorResponse(500, 'Error saving tenant', { error: error.message }));
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


app.get('/stats', async (req, res) => {
  const startTime = Date.now();
  console.log('\n[INFO] /stats endpoint called at:', new Date().toISOString());

  try {
    // === 1. Fetch All Properties ===
    console.log('[STEP 1] Fetching properties...');
    const propertiesSnap = await getDocs(collection(db, 'properties'));
    const propertiesCount = propertiesSnap.size;
    console.log(`[SUCCESS] Found ${propertiesCount} properties`);

    let totalUnits = 0;
    let totalRevenue = 0;
    let occupiedUnits = 0;
    let vacantUnits = 0;

    // === 2. Process Each Property ===
    for (const [idx, propDoc] of propertiesSnap.docs.entries()) {
      const propId = propDoc.id;
      const propData = propDoc.data();
      console.log(`[STEP 2.${idx + 1}] Property: ${propData.propertyName || propId}`);

      // Use stored unit IDs to fetch efficiently
      const unitIds = propData.propertyUnitIds || [];

      if (unitIds.length === 0) {
        console.log(`   → No units listed (propertyUnitIds missing)`);
        continue;
      }

      // Batch fetch all units for this property
      const unitRefs = unitIds.map(id => doc(db, 'units', id));
      const unitSnaps = await Promise.all(unitRefs.map(ref => getDoc(ref)));
      const validUnits = unitSnaps.filter(snap => snap.exists());

      totalUnits += validUnits.length;

      validUnits.forEach((unitSnap, uIdx) => {
        const unitData = unitSnap.data();

        const rent = parseFloat(unitData.rentAmount) || 0;
        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unitData.utilityFees?.waterBill) || 0;

        const unitTotal = rent + garbage + water;
        totalRevenue += unitTotal;

        if (unitData.isVacant === false) {
          occupiedUnits++;
          console.log(`   [UNIT ${uIdx + 1}] Occupied | Rent: ${rent} | Garbage: ${garbage} | Water: ${water} → Total: ${unitTotal}`);
        } else {
          vacantUnits++;
          console.log(`   [UNIT ${uIdx + 1}] Vacant   | Rent: ${rent} | Garbage: ${garbage} | Water: ${water} → Total: ${unitTotal}`);
        }
      });

      const propertyRevenue = validUnits.reduce((sum, snap) => {
        const d = snap.data();
        const r = parseFloat(d.rentAmount) || 0;
        const g = parseFloat(d.utilityFees?.garbageFee) || 0;
        const w = parseFloat(d.utilityFees?.waterBill) || 0;
        return sum + r + g + w;
      }, 0);

      console.log(`   → ${validUnits.length} units | Revenue: KSH ${propertyRevenue}`);
    }

    // === 3. Fetch Tenant Arrears ===
    console.log('[STEP 3] Fetching tenant arrears...');
    const tenantsSnap = await getDocs(collection(db, 'tenants'));
    let totalArrears = 0;

    tenantsSnap.docs.forEach((tenantDoc, tIdx) => {
      const tenantData = tenantDoc.data();
      const arrears = parseFloat(tenantData.arrears) || 0;
      totalArrears += arrears;
      if (arrears > 0) {
        console.log(`   [TENANT ${tIdx + 1}] ${tenantData.name || tenantDoc.id} → Arrears: KSH ${arrears}`);
      }
    });

    // === 4. Compile Final Stats ===
    const stats = {
      properties: propertiesCount,
      units: totalUnits,
      revenue: totalRevenue,
      arrears: totalArrears,
      occupied: occupiedUnits,
      vacant: vacantUnits,
      timestamp: new Date().toISOString(),
      queryDurationMs: Date.now() - startTime,
    };

    console.log('[SUCCESS] Stats compiled:');
    console.log(JSON.stringify(stats, null, 2));

    res.json({ success: true, data: stats });
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error(`[ERROR] Stats failed after ${duration}ms:`, {
      message: err.message,
      code: err.code,
      stack: err.stack,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to fetch stats',
      details: err.message,
      timestamp: new Date().toISOString(),
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`On Your Network: http://192.168.1.105:${PORT}`); // ← Your IP

});