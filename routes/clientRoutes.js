const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { collection, getDocs, getDoc, doc, addDoc, updateDoc, deleteDoc, query, where } = require('firebase/firestore');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const emailService = require('../services/emailService');

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

  // Calculate dynamic aggregates per client
  const enrichedClients = clientsList.map(client => {
    const clientProperties = propsList.filter(p => p.ownerId === client.id || (p.owner && p.owner.name === client.name));
    const propertyIds = clientProperties.map(p => p.propertyId || p.id);

    // Sum all rent payments collected for these properties
    const propertyPayments = finRecords.filter(r => propertyIds.includes(r.propertyId));
    const totalCollected = propertyPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

    // Commission
    const rate = parseFloat(client.commissionRate) || 0;
    const totalCommission = totalCollected * (rate / 100);
    const netPayoutDue = totalCollected - totalCommission;

    // Total Paid Payouts
    const clientPayouts = payoutsList.filter(p => p.clientId === client.id);
    const totalPaid = clientPayouts.reduce((sum, p) => sum + (p.amount || 0), 0);

    const outstanding = Math.max(0, netPayoutDue - totalPaid);

    return {
      ...client,
      propertiesCount: clientProperties.length,
      properties: clientProperties.map(p => ({ id: p.id, name: p.propertyName })),
      totalCollected,
      totalCommission,
      netPayoutDue,
      totalPaid,
      outstandingPayout: outstanding,
      payouts: clientPayouts.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt))
    };
  });

  res.json({ success: true, data: enrichedClients });
}));

// POST create client
router.post('/', asyncHandler(async (req, res) => {
  const { agencyId } = req.user;
  const { name, email, phone, commissionRate, payoutMethod, payoutDetails, notes } = req.body;

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
  const { name, email, phone, commissionRate, payoutMethod, payoutDetails, notes, assignedProperties } = req.body;

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
    } catch (mailErr) {
      console.error('❌ Failed to email client payout receipt:', mailErr.message);
    }
  }

  res.json({ success: true, data: { id: docRef.id, ...newPayout }, message: 'Payout recorded successfully' });
}));

module.exports = router;
