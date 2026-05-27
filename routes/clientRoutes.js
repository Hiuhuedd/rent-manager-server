const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { collection, getDocs, getDoc, doc, addDoc, updateDoc, deleteDoc, query, where } = require('firebase/firestore');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');

router.use(authMiddleware);

// GET all clients + stats + payouts
router.get('/', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  
  // 1. Fetch clients
  const clientsQ = query(collection(db, 'clients'), where('agencyId', '==', agencyId));
  const clientsSnap = await getDocs(clientsQ);
  const clientsList = clientsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // 2. Fetch properties to associate
  const propsQ = query(collection(db, 'properties'), where('agencyId', '==', agencyId));
  const propsSnap = await getDocs(propsQ);
  const propsList = propsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // 3. Fetch all financial records (tenant payments)
  const finQ = query(collection(db, 'financial_records'), where('agencyId', '==', agencyId));
  const finSnap = await getDocs(finQ);
  const finRecords = finSnap.docs.map(doc => doc.data());

  // 4. Fetch all payouts recorded
  const payoutsQ = query(collection(db, 'payouts'), where('agencyId', '==', agencyId));
  const payoutsSnap = await getDocs(payoutsQ);
  const payoutsList = payoutsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // 5. Fetch all running costs (expenses)
  const costsQ = query(collection(db, 'runningCosts'), where('agencyId', '==', agencyId));
  const costsSnap = await getDocs(costsQ);
  const costsList = costsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  // Calculate dynamic aggregates per client
  const enrichedClients = clientsList.map(client => {
    const clientProperties = propsList.filter(p => p.ownerId === client.id || (p.owner && p.owner.name === client.name));
    const propertyIds = clientProperties.map(p => p.propertyId || p.id);

    // Sum rent payments and compute property-specific commissions
    const propertyPayments = finRecords.filter(r => propertyIds.includes(r.propertyId));
    
    let totalCollected = 0;
    let totalCommission = 0;

    clientProperties.forEach(p => {
      const propPayments = propertyPayments.filter(r => r.propertyId === p.id);
      const propCollected = propPayments.reduce((sum, pay) => sum + (pay.amount || 0), 0);
      totalCollected += propCollected;

      // Property specific commission rate (default to 8%)
      const rate = p.agencyCommission !== undefined ? parseFloat(p.agencyCommission) : 8;
      totalCommission += propCollected * (rate / 100);
    });

    // Sum running costs / expenses for these properties
    const clientCosts = costsList.filter(c => propertyIds.includes(c.propertyId));
    const totalExpenses = clientCosts.reduce((sum, c) => sum + (c.amount || 0), 0);

    // Sum recorded payouts
    const clientPayouts = payoutsList.filter(p => p.clientId === client.id);
    const totalPaid = clientPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);

    const netPayoutDue = totalCollected - totalCommission - totalExpenses;
    const outstanding = Math.max(0, netPayoutDue - totalPaid);

    return {
      ...client,
      propertiesCount: clientProperties.length,
      properties: clientProperties.map(p => ({ id: p.id, name: p.propertyName })),
      totalCollected,
      totalCommission,
      totalExpenses,
      netPayoutDue,
      totalPaid,
      outstandingPayout: outstanding,
      payouts: clientPayouts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    };
  });

  // Calculate global agency utility and working account balances for Tier 2
  let mpesaBalances = { utility: 0, working: 0 };
  const settingsService = require('../services/settingsService');
  const settings = await settingsService.getSettings(agencyId);
  if (settings && settings.integrationTier === 'tier2') {
    const globalCollected = finRecords.reduce((sum, r) => sum + (r.amount || 0), 0);
    const globalPaidOut = payoutsList.reduce((sum, p) => sum + (p.amount || 0), 0);
    
    const globalCommission = enrichedClients.reduce((sum, c) => sum + c.totalCommission, 0);
    
    // Utility Account (receives all gross payments)
    mpesaBalances.utility = Math.max(0, globalCollected - globalPaidOut - globalCommission);
    // Working Account (funds available for disbursement/commission retention)
    mpesaBalances.working = Math.max(0, globalCommission);
  }

  res.json({ success: true, data: enrichedClients, mpesaBalances });
}));

// GET single client + stats + properties + payouts + expenses
router.get('/:id', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  const { id } = req.params;

  const clientRef = doc(db, 'clients', id);
  const clientSnap = await getDoc(clientRef);

  if (!clientSnap.exists() || clientSnap.data().agencyId !== agencyId) {
    return res.status(404).json({ success: false, error: 'Client not found' });
  }

  const client = { id: clientSnap.id, ...clientSnap.data() };

  // Fetch client properties
  const propsQ = query(collection(db, 'properties'), where('ownerId', '==', id), where('agencyId', '==', agencyId));
  const propsSnap = await getDocs(propsQ);
  const clientProperties = propsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  const propertyIds = clientProperties.map(p => p.id);

  // Fetch financial records (payments)
  let propertyPayments = [];
  let totalCollected = 0;
  let totalCommission = 0;

  if (propertyIds.length > 0) {
    const finQ = query(collection(db, 'financial_records'), where('agencyId', '==', agencyId));
    const finSnap = await getDocs(finQ);
    const finRecords = finSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    propertyPayments = finRecords.filter(r => propertyIds.includes(r.propertyId));
    
    // Group and calculate commission dynamically per property
    clientProperties.forEach(p => {
      const propPayments = propertyPayments.filter(r => r.propertyId === p.id);
      const propCollected = propPayments.reduce((sum, pay) => sum + (pay.amount || 0), 0);
      totalCollected += propCollected;

      const rate = p.agencyCommission !== undefined ? parseFloat(p.agencyCommission) : 8;
      totalCommission += propCollected * (rate / 100);
    });
  }

  // Fetch payouts recorded
  const payoutsQ = query(collection(db, 'payouts'), where('clientId', '==', id), where('agencyId', '==', agencyId));
  const payoutsSnap = await getDocs(payoutsQ);
  const clientPayouts = payoutsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }))
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  const totalPaid = clientPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);

  // Fetch expenses (running costs)
  let clientExpenses = [];
  let totalExpenses = 0;

  if (propertyIds.length > 0) {
    const costsQ = query(collection(db, 'runningCosts'), where('agencyId', '==', agencyId));
    const costsSnap = await getDocs(costsQ);
    const costsRecords = costsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    clientExpenses = costsRecords.filter(c => propertyIds.includes(c.propertyId));
    totalExpenses = clientExpenses.reduce((sum, cost) => sum + (cost.amount || 0), 0);
  }

  // Calculate Net payout due = Collected - Commission - Expenses
  const netPayoutDue = totalCollected - totalCommission - totalExpenses;
  const outstanding = Math.max(0, netPayoutDue - totalPaid);

  res.json({
    success: true,
    data: {
      ...client,
      properties: clientProperties.map(p => ({ 
        id: p.id, 
        name: p.propertyName, 
        agencyCommission: p.agencyCommission !== undefined ? p.agencyCommission : 8,
        unitsCount: p.propertyUnitsTotal || 0
      })),
      totalCollected,
      totalCommission,
      totalExpenses,
      totalPaid,
      outstandingPayout: outstanding,
      payouts: clientPayouts,
      expenses: clientExpenses.map(c => ({
        id: c.id,
        category: c.category,
        feeName: c.feeName,
        amount: c.amount,
        description: c.description,
        date: c.date,
        propertyName: clientProperties.find(p => p.id === c.propertyId)?.propertyName || 'Unknown Property'
      })).sort((a,b) => new Date(b.date) - new Date(a.date)),
      payments: propertyPayments.map(p => {
        const prop = clientProperties.find(prop => prop.id === p.propertyId);
        const rate = prop && prop.agencyCommission !== undefined ? parseFloat(prop.agencyCommission) : 8;
        const commissionEarned = (p.amount || 0) * (rate / 100);
        return {
          id: p.id,
          amount: p.amount,
          commissionEarned,
          type: p.type || 'rent',
          tenantName: p.tenantName || 'Tenant',
          unitName: p.unitName || 'Unit',
          createdAt: p.createdAt,
          propertyName: prop?.propertyName || 'Unknown Property'
        };
      }).sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    }
  });
}));

// POST create client
router.post('/', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  const { name, email, phone, commissionRate, payoutMethod, payoutDetails, accountName, notes } = req.body;

  if (!name) {
    return res.status(400).json({ success: false, error: 'Name is required' });
  }

  const newClient = {
    agencyId,
    name,
    email: email || '',
    phone: phone || '',
    commissionRate: parseFloat(commissionRate) || 0,
    payoutMethod: payoutMethod || 'mpesa',
    payoutDetails: payoutDetails || '',
    accountName: accountName || '',
    notes: notes || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const docRef = await addDoc(collection(db, 'clients'), newClient);
  
  res.json({ success: true, data: { id: docRef.id, ...newClient }, message: 'Client created successfully' });
}));

// PUT update client
router.put('/:id', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  const { id } = req.params;
  const { name, email, phone, commissionRate, payoutMethod, payoutDetails, accountName, notes, assignedProperties } = req.body;

  const clientRef = doc(db, 'clients', id);
  const clientSnap = await getDoc(clientRef);

  if (!clientSnap.exists() || clientSnap.data().agencyId !== agencyId) {
    return res.status(404).json({ success: false, error: 'Client not found' });
  }

  const updatedData = {
    name,
    email: email || '',
    phone: phone || '',
    commissionRate: parseFloat(commissionRate) || 0,
    payoutMethod: payoutMethod || 'mpesa',
    payoutDetails: payoutDetails || '',
    accountName: accountName || '',
    notes: notes || '',
    updatedAt: new Date().toISOString()
  };

  await updateDoc(clientRef, updatedData);

  // If assignedProperties (array of propertyIds) is provided, link them by updating property ownerId
  if (Array.isArray(assignedProperties)) {
    // 1. Clear ownerId for any properties currently linked to this client
    const propsQ = query(collection(db, 'properties'), where('ownerId', '==', id), where('agencyId', '==', agencyId));
    const propsSnap = await getDocs(propsQ);
    for (const d of propsSnap.docs) {
      await updateDoc(doc(db, 'properties', d.id), { ownerId: null, 'owner.name': '' });
    }

    // 2. Set ownerId for newly assigned properties
    for (const propId of assignedProperties) {
      const pRef = doc(db, 'properties', propId);
      await updateDoc(pRef, { ownerId: id, 'owner.name': name });
    }
  }

  res.json({ success: true, data: { id, ...clientSnap.data(), ...updatedData }, message: 'Client updated successfully' });
}));

// DELETE client
router.delete('/:id', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  const { id } = req.params;

  const clientRef = doc(db, 'clients', id);
  const clientSnap = await getDoc(clientRef);

  if (!clientSnap.exists() || clientSnap.data().agencyId !== agencyId) {
    return res.status(404).json({ success: false, error: 'Client not found' });
  }

  // Clear ownerId in all linked properties
  const propsQ = query(collection(db, 'properties'), where('ownerId', '==', id), where('agencyId', '==', agencyId));
  const propsSnap = await getDocs(propsQ);
  for (const d of propsSnap.docs) {
    await updateDoc(doc(db, 'properties', d.id), { ownerId: null, 'owner.name': '' });
  }

  await deleteDoc(clientRef);

  res.json({ success: true, message: 'Client deleted successfully' });
}));

// POST record payout + email receipt
router.post('/:id/payouts', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  const { id } = req.params;
  const { amount, paymentMethod, referenceNumber, notes, payoutMonth } = req.body;

  const clientRef = doc(db, 'clients', id);
  const clientSnap = await getDoc(clientRef);

  if (!clientSnap.exists() || clientSnap.data().agencyId !== agencyId) {
    return res.status(404).json({ success: false, error: 'Client not found' });
  }

  const client = clientSnap.data();
  const payoutAmount = parseFloat(amount);

  if (isNaN(payoutAmount) || payoutAmount <= 0) {
    return res.status(400).json({ success: false, error: 'Valid payout amount is required' });
  }

  const newPayout = {
    agencyId,
    clientId: id,
    clientName: client.name,
    clientEmail: client.email || '',
    amount: payoutAmount,
    payoutMonth: payoutMonth || 'All-Time',
    paymentMethod: paymentMethod || 'mpesa',
    referenceNumber: referenceNumber || '',
    notes: notes || '',
    createdAt: new Date().toISOString()
  };

  const docRef = await addDoc(collection(db, 'payouts'), newPayout);

  // Trigger real M-Pesa Payout if Method is M-Pesa and Agency is Tier 2
  if (paymentMethod === 'mpesa') {
    const settingsService = require('../services/settingsService');
    const dedicatedMpesaService = require('../services/payment/dedicatedMpesaService');
    const settings = await settingsService.getSettings(agencyId);
    
    if (settings && settings.integrationTier === 'tier2') {
      const credentials = settings.mpesaCredentials && settings.mpesaCredentials.consumerKey 
        ? settings.mpesaCredentials 
        : {
            consumerKey: process.env.KODIPAY_MASTER_CONSUMER_KEY || '',
            consumerSecret: process.env.KODIPAY_MASTER_CONSUMER_SECRET || '',
            initiatorName: process.env.KODIPAY_MASTER_INITIATOR_NAME || '',
            securityCredential: process.env.KODIPAY_MASTER_SECURITY_CREDENTIAL || '',
            shortCode: process.env.KODIPAY_MASTER_SHORTCODE || '4005473'
          };
          
      const actualPayoutMethod = client.payoutMethod || 'mpesa_b2c';
      const targetNumber = client.payoutDetails || client.phone;
      
      if (!targetNumber) {
        await deleteDoc(docRef);
        return res.status(400).json({ success: false, error: 'Landlord does not have configured M-Pesa payout details or phone number.' });
      }
      
      try {
        await dedicatedMpesaService.executeRealPayout(payoutAmount, actualPayoutMethod, targetNumber, referenceNumber || docRef.id, credentials);
      } catch (err) {
        console.error('❌ Manual payout execution failed:', err.message);
        // Clean up the created payout record since the transaction failed
        await deleteDoc(docRef);
        return res.status(400).json({ success: false, error: \`M-Pesa payment execution failed: \${err.message}\` });
      }
    }
  }

  // Email Payout Receipt to client
  if (client.email) {
    try {
      const emailSubject = `Client Payout Confirmed - KodiPay`;
      const emailHtml = `
        <div style="font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: auto; padding: 40px; background-color: #ffffff; border: 1px solid #f0f0f0; border-radius: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.02);">
          <div style="text-align: center; margin-bottom: 32px;">
            <div style="display: inline-block; width: 56px; height: 56px; background-color: #0f172a; border-radius: 16px; line-height: 56px; color: white; font-size: 24px; font-weight: bold; text-align: center;">K</div>
          </div>
          <h2 style="color: #0f172a; text-align: center; font-size: 22px; font-weight: 800; margin-bottom: 8px; tracking: -0.02em;">Payout Confirmed</h2>
          <p style="color: #64748b; text-align: center; font-size: 14px; line-height: 1.6; margin-bottom: 32px;">Dear ${client.name}, we have successfully processed and disbursed a payout for your properties.</p>
          
          <div style="background: #f8fafc; padding: 24px; border-radius: 16px; border: 1px solid #e2e8f0; margin-bottom: 32px;">
            <h3 style="font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.05em; color: #94a3b8; margin: 0 0 16px 0;">Payout details</h3>
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Client Name</td>
                <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${client.name}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Amount Paid</td>
                <td style="padding: 8px 0; color: #16a34a; font-weight: 800; text-align: right;">KSh ${payoutAmount.toLocaleString()}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Disbursal Method</td>
                <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right; text-transform: uppercase;">${paymentMethod}</td>
              </tr>
              ${referenceNumber ? `
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Reference Number</td>
                <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right; font-family: monospace;">${referenceNumber}</td>
              </tr>` : ''}
              <tr>
                <td style="padding: 8px 0; color: #64748b; font-weight: 500;">Payout Period</td>
                <td style="padding: 8px 0; color: #0f172a; font-weight: 700; text-align: right;">${payoutMonth || 'All-Time'}</td>
              </tr>
            </table>
          </div>

          ${notes ? `
          <div style="margin-bottom: 32px; font-size: 13px; color: #64748b; font-style: italic; line-height: 1.6; background-color: #fafafa; padding: 16px; border-radius: 12px; border-left: 3px solid #e2e8f0;">
            " ${notes} "
          </div>` : ''}

          <p style="color: #64748b; font-size: 13px; line-height: 1.6; text-align: center;">Thank you for partnering with us. Please feel free to contact our agency if you have any questions.</p>
          <div style="margin-top: 40px; padding-top: 24px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="font-size: 11px; color: #94a3b8;">&copy; 2026 KodiPay Inc. All rights reserved.</p>
          </div>
        </div>
      `;
      await emailService.sendEmail(client.email, emailSubject, emailHtml);
      console.log(`📧 Payout email receipt successfully sent to landlord ${client.email}`);
    } catch (mailErr) {
      console.error('❌ Failed to email client payout receipt:', mailErr.message);
    }
  } else {
    console.log(`⚠️ Skip payout email receipt: landlord has no registered email address`);
  }

  // Send SMS confirmation to client
  if (client.phone) {
    try {
      const formattedAmount = new Intl.NumberFormat('en-KE').format(payoutAmount);
      const smsMessage = `KodiPay: Payout Confirmed! KSh ${formattedAmount} has been disbursed to you for ${payoutMonth || 'All-Time'} via ${paymentMethod.toUpperCase()}.${referenceNumber ? ` Ref: ${referenceNumber}.` : ''} Thank you!`;
      
      const smsResult = await smsService.sendSMS(client.phone, smsMessage, agencyId, 'system', id);
      console.log(`📱 Payout SMS notification response for ${client.phone}:`, smsResult);
    } catch (smsErr) {
      console.error('❌ Failed to send SMS payout notification to landlord:', smsErr.message);
    }
  } else {
    console.log(`⚠️ Skip payout SMS: landlord has no registered phone number`);
  }

  res.json({ success: true, data: { id: docRef.id, ...newPayout }, message: 'Payout recorded successfully' });
}));

module.exports = router;
