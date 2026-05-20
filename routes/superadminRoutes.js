const express = require('express');
const router = express.Router();
const { doc, getDoc, collection, getDocs, query, where, setDoc, addDoc } = require('firebase/firestore');
const { getFirestoreApp } = require('../firebase');
const emailService = require('../services/emailService');
const smsService = require('../smsService');

router.post('/send-subscription-reminder', async (req, res) => {
  try {
    const { agencyId } = req.body;
    if (!agencyId) {
      return res.status(400).json({ success: false, error: 'agencyId is required' });
    }

    const db = getFirestoreApp();

    // 1. Fetch agency settings
    const settingsRef = doc(db, "settings", agencyId);
    const settingsSnap = await getDoc(settingsRef);
    if (!settingsSnap.exists()) {
      return res.status(404).json({ success: false, error: 'Agency settings not found' });
    }
    const settings = settingsSnap.data();

    // 2. Fetch agency info
    const agencyRef = doc(db, "agencies", agencyId);
    const agencySnap = await getDoc(agencyRef);
    const agencyData = agencySnap.exists() ? agencySnap.data() : {};

    // 3. Resolve Admin contacts
    const usersRef = collection(db, "users");
    const q = query(usersRef, where("agencyId", "==", agencyId), where("role", "==", "admin"));
    const usersSnap = await getDocs(q);
    
    let adminPhone = settings.customerServiceNumber || "";
    let adminEmail = agencyData.email || settings.email || "";
    let adminName = "Administrator";
    
    if (!usersSnap.empty) {
      const adminData = usersSnap.docs[0].data();
      adminPhone = adminData.phone || adminPhone;
      adminEmail = adminData.email || adminEmail;
      adminName = adminData.name || adminName;
    }

    if (!adminPhone && !adminEmail) {
      return res.status(400).json({ success: false, error: 'No registered admin phone number or email address found for this agency' });
    }

    const planName = agencyData.subscription?.activePlan || settings.agencyPlan || "starter";
    const formattedPlanName = planName.includes('trial') ? 'Free Trial (Demo)' : 
      planName.includes('starter') ? 'Starter Plan' :
      planName.includes('growth') ? 'Growth Plan' :
      planName.includes('professional') ? 'Professional Plan' : 'Enterprise Plan';

    const planPrice = planName.includes('trial') ? 0 : 
      planName.includes('starter') ? 3200 :
      planName.includes('growth') ? 6500 :
      planName.includes('professional') ? 15000 : 45000;

    const businessName = agencyData.name || settings.businessName || settings.agencyName || "Mwaura Properties";

    const msg = `Dear ${adminName}, your KodiPay subscription for ${businessName} (${formattedPlanName}) is due. Please log in to your account and pay from the billing board to maintain active access. Support: 0743466032.`;

    let smsStatus = 'skipped';
    let emailStatus = 'skipped';

    // 4. Send SMS if phone exists
    if (adminPhone) {
      try {
        console.log(`📤 Dispatching Sub SMS reminder to ${adminPhone}...`);
        const smsResult = await smsService.sendSMS(adminPhone, msg, agencyId, 'superadmin', 'sub-reminder');
        smsStatus = smsResult.success ? 'sent' : `failed: ${smsResult.error}`;
      } catch (smsErr) {
        console.error('❌ SMS dispatch error:', smsErr);
        smsStatus = `failed: ${smsErr.message}`;
      }
    }

    // 5. Send Email if email exists
    if (adminEmail) {
      try {
        console.log(`📧 Dispatching Sub Email reminder to ${adminEmail}...`);
        const subject = `Subscription Renewal Alert: Action Required - KodiPay`;
        const emailHtml = `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 30px; border: 1px solid #e2e8f0; border-radius: 16px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #0f172a; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">KodiPay System Operations</h1>
              <p style="color: #64748b; font-size: 12px; margin-top: 5px; text-transform: uppercase; font-weight: 700; letter-spacing: 1.5px;">Subscription Billing Alert</p>
            </div>
            
            <div style="padding: 20px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #f1f5f9; margin-bottom: 25px;">
              <p style="font-size: 15px; color: #1e293b; margin-top: 0;">Dear <strong>${adminName}</strong>,</p>
              <p style="font-size: 14px; color: #475569; line-height: 1.6;">
                This is an official administrative reminder that the subscription period for your agency platform <strong>${businessName}</strong> is due for renewal. Please log in to your account and pay from the billing section to avoid any system disruptions.
              </p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-bottom: 25px; font-size: 14px;">
              <tr style="border-bottom: 1px solid #f1f5f9;">
                <td style="padding: 10px 0; color: #64748b; font-weight: 600;">Licensing Plan</td>
                <td style="padding: 10px 0; color: #0f172a; font-weight: 700; text-align: right;">${formattedPlanName}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; color: #64748b; font-weight: 600;">Amount Due</td>
                <td style="padding: 10px 0; color: #16a34a; font-weight: 700; text-align: right;">KSh ${planPrice.toLocaleString()}</td>
              </tr>
            </table>

            <div style="text-align: center; margin: 30px 0;">
              <a href="https://rent-manager-client.onrender.com/dashboard/billing" style="display: inline-block; background-color: #0f172a; color: #ffffff; padding: 12px 28px; font-size: 14px; font-weight: 700; text-decoration: none; border-radius: 8px;">Log In & Pay Now</a>
            </div>

            <div style="padding: 15px; border-left: 4px solid #f59e0b; background-color: #fffbeb; color: #b45309; font-size: 12px; line-height: 1.5; margin-bottom: 30px; border-radius: 4px;">
              <strong>Important:</strong> Please ensure the payment is processed within the next 48 hours to guarantee uninterrupted operations of your portals, SMS dispatches, and rental ledger books.
            </div>

            <div style="border-top: 1px solid #f1f5f9; padding-top: 20px; font-size: 11px; color: #94a3b8; text-align: center;">
              <p>This is an automated system notification. If you have already made this payment, please disregard this alert.</p>
              <p>&copy; ${new Date().getFullYear()} KodiPay Inc. All Rights Reserved.</p>
            </div>
          </div>
        `;
        await emailService.sendEmail(adminEmail, subject, emailHtml);
        emailStatus = 'sent';
      } catch (emailErr) {
        console.error('❌ Email dispatch error:', emailErr);
        emailStatus = `failed: ${emailErr.message}`;
      }
    }

    return res.status(200).json({
      success: true,
      message: `Subscription reminder sent successfully!`,
      sms: smsStatus,
      email: emailStatus,
      targetPhone: adminPhone || 'N/A',
      targetEmail: adminEmail || 'N/A'
    });
  } catch (error) {
    console.error('❌ Superadmin Reminder API Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// DEMO REQUESTS SYSTEM
// ============================================

// 1. Submit a new demo request (Public endpoint)
router.post('/demo-requests', async (req, res) => {
  try {
    const { name, email, phone, portfolioSize } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, error: 'Name and Phone number are required' });
    }

    const db = getFirestoreApp();
    const demoRequestsRef = collection(db, 'demo_requests');
    const docRef = await addDoc(demoRequestsRef, {
      name,
      email: email || '',
      phone,
      portfolioSize: portfolioSize || '10-50',
      status: 'pending', // 'pending' | 'contacted' | 'completed'
      createdAt: new Date().toISOString()
    });

    // Send SMS Alert to Super Admin (0743466032)
    const superAdminPhone = '0743466032';
    const alertMsg = `KodiPay Demo Request! Name: ${name}, Phone: ${phone}, Email: ${email || 'N/A'}, Size: ${portfolioSize || '10-50'}.`;
    
    let smsStatus = 'skipped';
    try {
      console.log(`📤 Dispatching Demo Request SMS alert to ${superAdminPhone}...`);
      const smsResult = await smsService.sendSMS(superAdminPhone, alertMsg, 'superadmin', 'system', docRef.id);
      smsStatus = smsResult.success ? 'sent' : `failed: ${smsResult.error}`;
    } catch (smsErr) {
      console.error('❌ SMS dispatch error for Demo Alert:', smsErr);
      smsStatus = `failed: ${smsErr.message}`;
    }

    return res.status(200).json({
      success: true,
      message: 'Demo request submitted and alert sent',
      requestId: docRef.id,
      sms: smsStatus
    });
  } catch (error) {
    console.error('❌ Demo Request API Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 2. Fetch all demo requests (Super Admin endpoint)
router.get('/demo-requests', async (req, res) => {
  try {
    const db = getFirestoreApp();
    const demoRequestsRef = collection(db, 'demo_requests');
    
    const querySnapshot = await getDocs(demoRequestsRef);
    const requests = [];
    querySnapshot.forEach((doc) => {
      requests.push({ id: doc.id, ...doc.data() });
    });

    // Sort by createdAt descending
    requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.status(200).json({
      success: true,
      requests
    });
  } catch (error) {
    console.error('❌ Get Demo Requests Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// 3. Update demo request status (Super Admin endpoint)
router.patch('/demo-requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Status is required' });
    }

    const db = getFirestoreApp();
    const docRef = doc(db, 'demo_requests', id);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      return res.status(404).json({ success: false, error: 'Demo request not found' });
    }

    await setDoc(docRef, { ...docSnap.data(), status }, { merge: true });

    return res.status(200).json({
      success: true,
      message: 'Status updated successfully'
    });
  } catch (error) {
    console.error('❌ Update Demo Request Error:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
