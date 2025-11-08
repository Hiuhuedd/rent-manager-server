
const express = require('express');
const { getFirestoreApp } = require('./firebase');
const { doc, getDoc, setDoc, collection, getDocs, query, where, addDoc, updateDoc, writeBatch, deleteDoc } = require('firebase/firestore');
const smsProcessor = require('./smsProcessor');
const SMSService = require('./smsService');

const app = express();
const db = getFirestoreApp();

app.use(express.json());

const cors = require('cors');
const { initializeMonthlyCronJob, createManualResetEndpoint } = require('./cronScheduler');

// After app initialization and before routes:
// Initialize monthly payment reset cron job
initializeMonthlyCronJob();

// Create manual reset endpoint
createManualResetEndpoint(app);
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











// ============================================
// NEW ENDPOINTS TO ADD
// ============================================

// GET /tenants/:id/payment-status - Get detailed payment status for a tenant
app.get('/tenants/:id/payment-status', async (req, res) => {
  try {
    const tenantRef = doc(db, 'tenants', req.params.id);
    const tenantSnap = await getDoc(tenantRef);
    
    if (!tenantSnap.exists()) {
      return res.status(404).json(createErrorResponse(404, 'Tenant not found'));
    }
    
    const tenant = tenantSnap.data();
    const monthlyTracking = tenant.monthlyPaymentTracking || {};
    
    res.json({
      success: true,
      tenantId: req.params.id,
      tenantName: tenant.name,
      unitCode: tenant.unitCode,
      currentMonth: monthlyTracking.month,
      paymentStatus: monthlyTracking.status || 'unpaid',
      expected: monthlyTracking.expectedAmount || 0,
      paid: monthlyTracking.paidAmount || 0,
      remaining: monthlyTracking.remainingAmount || 0,
      breakdown: monthlyTracking.breakdown || {},
      payments: monthlyTracking.payments || [],
      financialSummary: tenant.financialSummary || {},
      depositStatus: tenant.rentDeposit?.status || 'not_required'
    });
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching payment status', { error: error.message }));
  }
});

// GET /payments/monthly-report - Get monthly payment report for all tenants
app.get('/payments/monthly-report', async (req, res) => {
  try {
    const { month } = req.query; // Format: YYYY-MM
    const targetMonth = month || getCurrentMonth();
    
    console.log(`📊 Generating monthly report for: ${targetMonth}`);
    
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    const report = {
      month: targetMonth,
      summary: {
        totalTenants: 0,
        paidInFull: 0,
        partialPayment: 0,
        unpaid: 0,
        totalExpected: 0,
        totalReceived: 0,
        totalRemaining: 0
      },
      tenants: []
    };
    
    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      const tracking = tenant.monthlyPaymentTracking || {};
      
      // Only include if tracking exists for target month
      if (tracking.month === targetMonth) {
        report.summary.totalTenants++;
        report.summary.totalExpected += tracking.expectedAmount || 0;
        report.summary.totalReceived += tracking.paidAmount || 0;
        report.summary.totalRemaining += tracking.remainingAmount || 0;
        
        switch (tracking.status) {
          case 'paid':
            report.summary.paidInFull++;
            break;
          case 'partial':
            report.summary.partialPayment++;
            break;
          case 'unpaid':
            report.summary.unpaid++;
            break;
        }
        
        report.tenants.push({
          tenantId: tenantDoc.id,
          name: tenant.name,
          unitCode: tenant.unitCode,
          propertyName: tenant.propertyDetails?.propertyName,
          status: tracking.status,
          expected: tracking.expectedAmount,
          paid: tracking.paidAmount,
          remaining: tracking.remainingAmount,
          breakdown: tracking.breakdown,
          payments: tracking.payments
        });
      }
    }
    
    console.log(`✅ Report generated: ${report.summary.totalTenants} tenants`);
    res.json({ success: true, report });
    
  } catch (error) {
    console.error('❌ Error generating monthly report:', error);
    res.status(500).json(createErrorResponse(500, 'Error generating report', { error: error.message }));
  }
});

// GET /payments/overdue - Get list of tenants with overdue payments
app.get('/payments/overdue', async (req, res) => {
  try {
    const currentMonth = getCurrentMonth();
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    
    const overdueList = [];
    
    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      const tracking = tenant.monthlyPaymentTracking || {};
      
      // Check if current month payment is not complete
      if (tracking.month === currentMonth && tracking.status !== 'paid') {
        overdueList.push({
          tenantId: tenantDoc.id,
          name: tenant.name,
          phone: tenant.phone,
          unitCode: tenant.unitCode,
          propertyName: tenant.propertyDetails?.propertyName,
          expectedAmount: tracking.expectedAmount || 0,
          paidAmount: tracking.paidAmount || 0,
          remainingAmount: tracking.remainingAmount || 0,
          status: tracking.status,
          arrears: tenant.financialSummary?.arrears || 0
        });
      }
    }
    
    console.log(`📋 Found ${overdueList.length} tenants with incomplete payments`);
    res.json({
      success: true,
      month: currentMonth,
      count: overdueList.length,
      tenants: overdueList
    });
    
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error fetching overdue payments', { error: error.message }));
  }
});

// POST /payments/send-reminders - Send payment reminders to overdue tenants
app.post('/payments/send-reminders', async (req, res) => {
  try {
    const currentMonth = getCurrentMonth();
    const tenantsSnapshot = await getDocs(collection(db, 'tenants'));
    
    const remindersSent = [];
    const remindersFailed = [];
    
    for (const tenantDoc of tenantsSnapshot.docs) {
      const tenant = tenantDoc.data();
      const tracking = tenant.monthlyPaymentTracking || {};
      
      // Only send to tenants with incomplete current month payments
      if (tracking.month === currentMonth && tracking.status !== 'paid') {
        try {
          const debt = {
            debtCode: tenant.unitCode,
            storeOwner: { name: tenant.name },
            remainingAmount: tracking.remainingAmount || 0,
            paymentMethod: 'mpesa',
            dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
          };
          
          const smsMessage = SMSService.generateInvoiceSMS(debt, tenant.phone);
          const smsResult = await SMSService.sendSMS(tenant.phone, smsMessage, tenantDoc.id, tenant.unitCode);
          
          if (smsResult.success) {
            remindersSent.push({
              tenantId: tenantDoc.id,
              name: tenant.name,
              phone: tenant.phone,
              amount: tracking.remainingAmount,
              messageId: smsResult.messageId
            });
            
            // Log reminder sent
            await updateDoc(doc(db, 'tenants', tenantDoc.id), {
              lastReminderSent: new Date().toISOString(),
              reminderCount: (tenant.reminderCount || 0) + 1
            });
          } else {
            remindersFailed.push({
              tenantId: tenantDoc.id,
              name: tenant.name,
              error: smsResult.error
            });
          }
        } catch (error) {
          remindersFailed.push({
            tenantId: tenantDoc.id,
            name: tenant.name,
            error: error.message
          });
        }
      }
    }
    
    console.log(`📱 Reminders sent: ${remindersSent.length}, Failed: ${remindersFailed.length}`);
    res.json({
      success: true,
      month: currentMonth,
      sent: remindersSent.length,
      failed: remindersFailed.length,
      details: {
        sent: remindersSent,
        failed: remindersFailed
      }
    });
    
  } catch (error) {
    res.status(500).json(createErrorResponse(500, 'Error sending reminders', { error: error.message }));
  }
});







// POST /webhook - Process M-Pesa SMS Payments
app.post('/webhook', async (req, res) => {
  console.log('\n📩 === NEW M-PESA SMS WEBHOOK RECEIVED ===');

  try {
    const webhookData = req.body;
    console.log('📥 Incoming Webhook Data:', JSON.stringify(webhookData, null, 2));

    // ---------------------------
    // 1️⃣ Validate request payload
    // ---------------------------
    if (!webhookData || !webhookData.body) {
      console.error('❌ No SMS message provided in the request body');
      return res.status(400).json({
        success: false,
        message: 'SMS message body is required',
        receivedBody: req.body,
      });
    }

    // ---------------------------
    // 2️⃣ Parse the SMS message
    // ---------------------------
    const parsedSMS = smsProcessor.parseMpesaWebhook(webhookData);

    if (!parsedSMS.success) {
      console.warn('⚠️ Failed to parse SMS:', parsedSMS.error);
      return res.status(400).json({
        success: false,
        message: 'Invalid SMS message format',
        error: parsedSMS.error,
        rawBody: webhookData.body,
      });
    }

    const {
      transactionId,
      accountNumber,
      amount,
      date,
      payerName,
      paymentMethod,
    } = parsedSMS.data;

    console.log(`✅ Payment parsed: ${payerName} paid KSh ${amount} for ${accountNumber}`);

    // ---------------------------
    // 3️⃣ Check for duplicate payment
    // ---------------------------
    const paymentRef = doc(db, 'rental_payments', transactionId);
    const paymentSnap = await getDoc(paymentRef);

    if (paymentSnap.exists()) {
      console.warn(`⚠️ Duplicate transaction: ${transactionId} already recorded`);
      return res.status(409).json({
        success: false,
        message: `Transaction ${transactionId} already processed`,
        transactionId,
      });
    }

    // ---------------------------
    // 4️⃣ Process payment (match tenant by accountNumber)
    // ---------------------------
    console.log(`🔍 Searching for tenant using accountNumber: ${accountNumber}`);

    const paymentResult = await smsProcessor.processRentalPayment({
      ...parsedSMS.data,
      phoneToMatch: accountNumber, // only accountNumber is used for matching tenant
    });

    if (!paymentResult.success) {
      console.error('❌ Failed to process rental payment:', paymentResult.error);
      return res.status(400).json({
        success: false,
        message: 'Payment processing failed',
        error: paymentResult.error,
        houseNumber: accountNumber,
      });
    }

    // ---------------------------
    // 5️⃣ Store payment record in Firestore
    // ---------------------------
    await setDoc(paymentRef, {
      ...parsedSMS.data,
      status: 'processed',
      timestamp: new Date().toISOString(),
    });

    console.log('✅ Payment saved successfully in Firestore.');

    // ---------------------------
    // 6️⃣ Return success response
    // ---------------------------
    console.log('🎉 Webhook completed successfully:', JSON.stringify(paymentResult, null, 2));

    return res.status(200).json({
      success: true,
      message: 'Rental payment processed successfully',
      payment: paymentResult,
    });
  } catch (error) {
    // ---------------------------
    // 7️⃣ Global error handler
    // ---------------------------
    console.error('💥 Webhook Error:', error.message, '\n', error.stack);

    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
      stack: error.stack,
    });
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
const deposit = parseFloat(unit.depositAmount) || 0; // NEW
const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
const water = parseFloat(unit.utilityFees?.waterBill) || 0;


      const unitTotal = rent + garbage + water + deposit;
totalRevenue += unitTotal;

const unitData = {
  unitId,
  propertyId,
  isVacant: true,
  category: unit.category || 'Standard',
  rentAmount: rent,
  depositAmount: deposit, // NEW
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

app.post('/tenants', async (req, res) => {
  const start = Date.now();
  console.log('\n=== NEW /tenants REQUEST ===');

  try {
    const { 
      id, 
      name, 
      unitCode, 
      phone,
      propertyDetails,
      rentDeposit,
      paymentTimeline,
      paymentLogs,
      financialSummary,
      tenantStatus,
      moveInDate,
      moveOutDate,
      contactInfo,
      identification,
      notes,
      utilityFees
    } = req.body;
    
    console.log('📥 Incoming tenant data:', req.body);

    // Validate required fields
    if (!unitCode || !name || !phone) {
      console.warn('⚠️ Missing required fields:', { unitCode, name, phone });
      return res.status(400).json(createErrorResponse(400, 'Name, unitCode, and phone are required'));
    }

    // ---------------------------
    // 1️⃣ Verify Unit Exists
    // ---------------------------
    console.log('🔍 Checking if unit exists for unitId:', unitCode);
    const unitsQuery = query(collection(db, 'units'), where('unitId', '==', unitCode));
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) {
      console.error('❌ Unit not found for unitId:', unitCode);
      return res.status(400).json(createErrorResponse(400, `Unit ${unitCode} not found`));
    }

    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc.data();
    const propertyDoc = await getDoc(doc(db, 'properties', unit.propertyId));
    console.log('✅ Unit found:', { 
      propertyId: unit.propertyId, 
      isVacant: unit.isVacant, 
      rentAmount: unit.rentAmount,
      depositAmount: unit.depositAmount 
    });

    // ---------------------------
    // 2️⃣ Create Comprehensive Tenant Data
    // ---------------------------
    const now = new Date().toISOString();
    
    // Calculate deposit amount from unit data
    const depositAmount = unit.depositAmount || 0;
    
    const tenantData = {
      // Core fields (required)
      name: name.trim(),
      unitCode,
      phone: phone.trim(),
      propertyId: unit.propertyId,
      
      // Property Details
      propertyDetails: propertyDetails || {
        propertyId: unit.propertyId,
        propertyName: propertyDoc.exists() ? propertyDoc.data().propertyName : 'Unknown',
        unitCategory: unit.category || 'Unknown',
        rentAmount: unit.rentAmount || 0,
        depositAmount: depositAmount,
      },
      
      // Rent Deposit Information
      rentDeposit: rentDeposit || {
        amount: depositAmount,
        status: depositAmount > 0 ? 'pending' : 'not_required',
        paidDate: null,
        refundStatus: depositAmount > 0 ? 'active' : 'not_applicable',
        notes: depositAmount > 0 ? `Security deposit of KSH ${depositAmount} required` : 'No deposit required',
      },
      
      // Payment Timeline
      paymentTimeline: paymentTimeline || {
        leaseStartDate: now,
        leaseEndDate: null,
        rentDueDay: 1,
        nextPaymentDate: new Date(new Date().setMonth(new Date().getMonth() + 1, 1)).toISOString(),
        lastPaymentDate: null,
        paymentFrequency: 'monthly',
      },
      
      // Payment Logs
      paymentLogs: paymentLogs || [],
      
      // Financial Summary
      financialSummary: financialSummary || {
        totalPaid: 0,
        totalDue: unit.rentAmount || 0,
        arrears: unit.rentAmount || 0,
        balance: 0,
        depositAmount: depositAmount,
        depositStatus: depositAmount > 0 ? 'pending' : 'not_required',
        lastUpdated: now,
      },
      
      // Legacy field for backward compatibility
      arrears: unit.rentAmount || 0,
      
      // Status & Metadata
      tenantStatus: tenantStatus || 'active',
      moveInDate: moveInDate || now,
      moveOutDate: moveOutDate || null,
      createdAt: id ? undefined : now,
      updatedAt: now,
      
      // Contact & Emergency Info
      contactInfo: contactInfo || {
        email: null,
        alternatePhone: null,
        emergencyContact: {
          name: null,
          phone: null,
          relationship: null,
        },
      },
      
      // Identification
      identification: identification || {
        idNumber: null,
        idType: null,
        idDocumentUrl: null,
      },
      
      // Notes & Agreements
      notes: notes || {
        moveInNotes: 'New tenant added via mobile app',
        specialTerms: null,
        restrictions: null,
      },
      
      // Utility Fees
      utilityFees: utilityFees || unit.utilityFees || {
        garbageFee: 0,
        waterBill: 0,
        electricity: 0,
        other: 0,
      },
    };

    let tenantId;
    let isNewTenant = false;

    if (id) {
      console.log('✏️ Updating existing tenant:', id);
      Object.keys(tenantData).forEach(key => 
        tenantData[key] === undefined && delete tenantData[key]
      );
      await updateDoc(doc(db, 'tenants', id), tenantData);
      tenantId = id;
    } else {
      console.log('➕ Creating new tenant document...');
      const tenantRef = await addDoc(collection(db, 'tenants'), tenantData);
      tenantId = tenantRef.id;
      isNewTenant = true;
    }

    console.log('✅ Tenant saved successfully:', tenantId);

    // ---------------------------
    // 3️⃣ Link Tenant to Unit
    // ---------------------------
    console.log(`🔗 Linking tenant (${tenantId}) to unit (${unitCode})...`);
    const unitRef = doc(db, 'units', unitDoc.id);
    await updateDoc(unitRef, {
      tenantId,
      isVacant: false,
    });
    console.log('✅ Unit updated: tenant linked & marked occupied.');

    // ---------------------------
    // 4️⃣ Update Property Stats
    // ---------------------------
    console.log(`🏠 Updating property (${unit.propertyId}) occupancy and revenue...`);
    const propertyRef = doc(db, 'properties', unit.propertyId);
    const propertySnap = await getDoc(propertyRef);

    if (propertySnap.exists()) {
      const propertyData = propertySnap.data();
      const newVacantCount = Math.max((propertyData.propertyVacantUnits || 1) - 1, 0);
      const newRevenue = (propertyData.propertyRevenueTotal || 0) + (unit.rentAmount || 0);

      await updateDoc(propertyRef, {
        propertyVacantUnits: newVacantCount,
        propertyRevenueTotal: newRevenue,
      });

      console.log(`✅ Property updated — Vacant: ${newVacantCount}, Revenue: ${newRevenue}`);
    } else {
      console.warn('⚠️ Property document not found:', unit.propertyId);
    }

    // ---------------------------
    // 5️⃣ Create Initial Payment Log Entry (Optional)
    // ---------------------------
    if (isNewTenant) {
      console.log('📝 Creating initial payment log entry...');
      try {
        await addDoc(collection(db, 'paymentLogs'), {
          tenantId,
          unitCode,
          propertyId: unit.propertyId,
          type: 'rent_due',
          amount: unit.rentAmount || 0,
          dueDate: tenantData.paymentTimeline.nextPaymentDate,
          status: 'pending',
          createdAt: now,
          month: new Date().toISOString().slice(0, 7),
        });
        console.log('✅ Initial payment log created');
      } catch (logError) {
        console.warn('⚠️ Failed to create payment log:', logError.message);
      }
    }

    // ---------------------------
    // 6️⃣ Send Welcome SMS to New Tenant
    // ---------------------------
    if (isNewTenant) {
      console.log('📱 Sending welcome SMS to new tenant...');
      try {
        const smsService = require('./smsService');
        
        // Format phone number for SMS (convert to +254 format)
        let formattedPhoneForSMS = phone.trim();
        if (formattedPhoneForSMS.startsWith('0')) {
          formattedPhoneForSMS = '+254' + formattedPhoneForSMS.substring(1);
        } else if (!formattedPhoneForSMS.startsWith('+254') && !formattedPhoneForSMS.startsWith('254')) {
          formattedPhoneForSMS = '+254' + formattedPhoneForSMS;
        }
        
        console.log(`📞 Phone number formatted for SMS: ${phone.trim()} -> ${formattedPhoneForSMS}`);
        
        // Calculate total utility fees
        const utilityFeesData = tenantData.utilityFees;
        const totalUtilityFees = (utilityFeesData.garbageFee || 0) + 
                                 (utilityFeesData.waterBill || 0) + 
                                 (utilityFeesData.electricity || 0) + 
                                 (utilityFeesData.other || 0);
        const rentAmount = unit.rentAmount || 0;
        const totalMonthlyCharge = rentAmount + totalUtilityFees;

        console.log('💰 Charges breakdown:');
        console.log(`   - Rent: KSH ${rentAmount}`);
        console.log(`   - Utilities: KSH ${totalUtilityFees}`);
        console.log(`   - Total Monthly: KSH ${totalMonthlyCharge}`);
        console.log(`   - Deposit: KSH ${depositAmount}`);
        
        // Prepare payment info (account number stays in 0xxx format for Paybill)
        const paymentInfo = {
          paybill: '522533',
          accountNumber: phone.trim().startsWith('0') ? phone.trim() : `0${phone.trim().replace(/^\+254/, '').replace(/^254/, '')}`,
        };

        console.log(`💳 Payment account number: ${paymentInfo.accountNumber}`);

        // Prepare tenant data for SMS with deposit info
        const tenantSMSData = {
          name: name.trim(),
          unitCode,
          rentAmount: rentAmount,
          utilityFees: totalUtilityFees,
          totalAmount: totalMonthlyCharge,
          depositAmount: depositAmount,
          phone: phone.trim(),
        };

        // Generate and send welcome message with deposit info
        const welcomeMessage = smsService.generateTenantWelcomeSMS(tenantSMSData, paymentInfo);
        const smsResult = await smsService.sendSMS(
          formattedPhoneForSMS,
          welcomeMessage,
          'system',
          tenantId
        );

        if (smsResult.success) {
          console.log('✅ Welcome SMS sent successfully');
          console.log(`   - Message ID: ${smsResult.messageId}`);
          
          await updateDoc(doc(db, 'tenants', tenantId), {
            welcomeSMSSent: true,
            welcomeSMSMessageId: smsResult.messageId,
            welcomeSMSSentAt: now,
          });
        } else {
          console.warn('⚠️ Failed to send welcome SMS:', smsResult.error);
          
          await updateDoc(doc(db, 'tenants', tenantId), {
            welcomeSMSSent: false,
            welcomeSMSError: smsResult.error,
            welcomeSMSAttemptedAt: now,
          });
        }
      } catch (smsError) {
        console.error('❌ Error sending welcome SMS:', smsError.message);
      }
    }

    // ---------------------------
    // ✅ Response
    // ---------------------------
    const duration = Date.now() - start;
    console.log(`🎯 Tenant "${name}" successfully linked to "${unitCode}" in ${duration} ms`);
    console.log('=== END REQUEST ===\n');

    res.json({
      success: true,
      message: 'Tenant created and linked successfully',
      id: tenantId,
      data: {
        tenantId,
        name: tenantData.name,
        unitCode: tenantData.unitCode,
        propertyId: tenantData.propertyId,
        moveInDate: tenantData.moveInDate,
        financialSummary: tenantData.financialSummary,
        depositInfo: {
          amount: depositAmount,
          status: tenantData.rentDeposit.status,
        },
        welcomeSMSSent: isNewTenant,
      },
      durationMs: duration,
    });

  } catch (error) {
    console.error('❌ SERVER ERROR while creating tenant:', error.stack || error);
    res.status(500).json(
      createErrorResponse(500, 'Error saving tenant', { error: error.message })
    );
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
    let expectedMonthlyRevenue = 0; // Only from occupied units
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

      // Get all tenant IDs for this property to check for new tenants
      const occupiedUnitTenantIds = validUnits
        .filter(snap => !snap.data().isVacant && snap.data().tenantId)
        .map(snap => snap.data().tenantId);

      // Fetch tenants in batch to check move-in dates
      const tenantRefs = occupiedUnitTenantIds.map(id => doc(db, 'tenants', id));
      const tenantSnaps = await Promise.all(tenantRefs.map(ref => getDoc(ref)));
      const tenantsMap = new Map();
      
      tenantSnaps.forEach(snap => {
        if (snap.exists()) {
          tenantsMap.set(snap.id, snap.data());
        }
      });

      validUnits.forEach((unitSnap, uIdx) => {
        const unitData = unitSnap.data();

        const rent = parseFloat(unitData.rentAmount) || 0;
        const deposit = parseFloat(unitData.depositAmount) || 0;
        const garbage = parseFloat(unitData.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unitData.utilityFees?.waterBill) || 0;

        if (unitData.isVacant === false) {
          occupiedUnits++;
          
          // Check if this is a new tenant (moved in this month)
          const tenantData = tenantsMap.get(unitData.tenantId);
          const isNewTenant = tenantData && isMovedInThisMonth(tenantData.moveInDate);
          
          // For new tenants, include deposit in expected revenue
          const unitMonthlyTotal = rent + garbage + water + (isNewTenant ? deposit : 0);
          expectedMonthlyRevenue += unitMonthlyTotal;
          
          console.log(`   [UNIT ${uIdx + 1}] Occupied | Rent: ${rent} | Deposit: ${isNewTenant ? deposit : 0} | Garbage: ${garbage} | Water: ${water} → Total: ${unitMonthlyTotal}`);
        } else {
          vacantUnits++;
          console.log(`   [UNIT ${uIdx + 1}] Vacant (not counted in revenue)`);
        }
      });

      console.log(`   → ${validUnits.length} units | ${occupiedUnits} occupied | Expected Monthly Revenue: KSH ${expectedMonthlyRevenue}`);
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
      revenue: expectedMonthlyRevenue, // Now only includes occupied units + deposits for new tenants
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

// Helper function to check if tenant moved in this month
function isMovedInThisMonth(moveInDate) {
  if (!moveInDate) return false;
  
  const moveIn = new Date(moveInDate);
  const now = new Date();
  
  return moveIn.getMonth() === now.getMonth() && 
         moveIn.getFullYear() === now.getFullYear();
}


// Add this endpoint to your server file

app.delete('/tenants/:tenantId', async (req, res) => {
  const start = Date.now();
  console.log('\n=== DELETE TENANT REQUEST ===');

  try {
    const { tenantId } = req.params;
    console.log('🗑️ Tenant ID to remove:', tenantId);

    // ---------------------------
    // 1️⃣ Get Tenant Data
    // ---------------------------
    const tenantRef = doc(db, 'tenants', tenantId);
    const tenantSnap = await getDoc(tenantRef);

    if (!tenantSnap.exists()) {
      console.error('❌ Tenant not found:', tenantId);
      return res.status(404).json(createErrorResponse(404, 'Tenant not found'));
    }

    const tenantData = tenantSnap.data();
    console.log('✅ Tenant found:', {
      name: tenantData.name,
      unitCode: tenantData.unitCode,
      propertyId: tenantData.propertyId,
    });

    // ---------------------------
    // 2️⃣ Get Unit Data
    // ---------------------------
    console.log('🔍 Finding unit:', tenantData.unitCode);
    const unitsQuery = query(
      collection(db, 'units'),
      where('unitId', '==', tenantData.unitCode)
    );
    const unitsSnapshot = await getDocs(unitsQuery);

    if (unitsSnapshot.empty) {
      console.warn('⚠️ Unit not found for unitId:', tenantData.unitCode);
    }

    const unitDoc = unitsSnapshot.docs[0];
    const unit = unitDoc?.data();

    // ---------------------------
    // 3️⃣ Update Unit (Mark as Vacant)
    // ---------------------------
    if (unitDoc) {
      console.log('🔓 Marking unit as vacant...');
      const unitRef = doc(db, 'units', unitDoc.id);
      await updateDoc(unitRef, {
        tenantId: null,
        isVacant: true,
      });
      console.log('✅ Unit marked as vacant');
    }

    // ---------------------------
    // 4️⃣ Update Property Stats
    // ---------------------------
    console.log('🏠 Updating property stats...');
    const propertyRef = doc(db, 'properties', tenantData.propertyId);
    const propertySnap = await getDoc(propertyRef);

    if (propertySnap.exists()) {
      const propertyData = propertySnap.data();
      const newVacantCount = (propertyData.propertyVacantUnits || 0) + 1;
      const rentAmount = unit?.rentAmount || 0;
      const newRevenue = Math.max((propertyData.propertyRevenueTotal || 0) - rentAmount, 0);

      await updateDoc(propertyRef, {
        propertyVacantUnits: newVacantCount,
        propertyRevenueTotal: newRevenue,
      });

      console.log(`✅ Property updated — Vacant: ${newVacantCount}, Revenue: ${newRevenue}`);
    } else {
      console.warn('⚠️ Property not found:', tenantData.propertyId);
    }

    // ---------------------------
    // 5️⃣ Delete Tenant Document
    // ---------------------------
    console.log('🗑️ Deleting tenant document...');
    await deleteDoc(tenantRef);
    console.log('✅ Tenant document deleted from Firestore');

    // ---------------------------
    // 6️⃣ Update Payment Logs Status
    // ---------------------------
    console.log('📝 Updating payment logs...');
    try {
      const paymentLogsQuery = query(
        collection(db, 'paymentLogs'),
        where('tenantId', '==', tenantId),
        where('status', '==', 'pending')
      );
      const paymentLogsSnapshot = await getDocs(paymentLogsQuery);

      const updatePromises = paymentLogsSnapshot.docs.map((doc) =>
        updateDoc(doc.ref, {
          status: 'cancelled',
          cancelledAt: new Date().toISOString(),
          cancelReason: 'Tenant deleted',
        })
      );

      await Promise.all(updatePromises);
      console.log(`✅ Updated ${updatePromises.length} payment logs`);
    } catch (logError) {
      console.warn('⚠️ Failed to update payment logs:', logError.message);
    }

    // ---------------------------
    // ✅ Response
    // ---------------------------
    const duration = Date.now() - start;
    console.log(`🎯 Tenant "${tenantData.name}" deleted successfully in ${duration} ms`);
    console.log('=== END REQUEST ===\n');

    res.json({
      success: true,
      message: 'Tenant deleted successfully',
      data: {
        tenantId,
        name: tenantData.name,
        unitCode: tenantData.unitCode,
        deletedAt: new Date().toISOString(),
      },
      durationMs: duration,
    });

  } catch (error) {
    console.error('❌ SERVER ERROR while deleting tenant:', error.stack || error);
    res.status(500).json(
      createErrorResponse(500, 'Error deleting tenant', { error: error.message })
    );
  }
});



const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Local: http://localhost:${PORT}`);
  console.log(`On Your Network: http://192.168.1.105:${PORT}`); // ← Your IP

});