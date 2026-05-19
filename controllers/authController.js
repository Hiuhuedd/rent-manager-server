const { db } = require('../config/firebase');
const { doc, setDoc, collection, getDoc, deleteDoc, query, where, getDocs, limit } = require('firebase/firestore');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'kodipay_secret_2026_xyz';

class AuthController {
  /**
   * Send a verification OTP to the user's email or phone
   */
  async sendVerification(req, res) {
    try {
      const { email, phone } = req.body;
      if (!email && !phone) return res.status(400).json(createErrorResponse('Email or Phone is required'));

      const identifier = email || phone;
      
      // Generate 4-digit OTP
      const otp = Math.floor(1000 + Math.random() * 9000).toString();
      
      // Store OTP in Firestore
      const otpRef = doc(db, 'verifications', identifier);
      await setDoc(otpRef, {
        otp,
        identifier,
        type: email ? 'email' : 'phone',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60000).toISOString() // 10 mins
      });

      // Send via appropriate channel
      if (email) {
        await emailService.sendOtpEmail(email, otp);
      } else {
        await smsService.sendSMS(
            phone, 
            `Your KodiPay verification code is ${otp}. Valid for 10 minutes.`,
            'auth',
            'system',
            'auth_otp'
        );
      }

      res.status(200).json(createSuccessResponse(null, 'Verification code sent'));
    } catch (error) {
      console.error('❌ Send Verification Error:', error.message);
      res.status(500).json(createErrorResponse('Failed to send verification code', error.message));
    }
  }

  /**
   * Verify the OTP and return a session token
   */
  async verifyOtp(req, res) {
    try {
      const { email, phone, otp } = req.body;
      const identifier = email || phone;
      
      if (!identifier || !otp) return res.status(400).json(createErrorResponse('Identifier and OTP are required'));

      const otpRef = doc(db, 'verifications', identifier);
      const otpSnap = await getDoc(otpRef);

      if (!otpSnap.exists()) {
        return res.status(400).json(createErrorResponse('No verification code found'));
      }

      const data = otpSnap.data();
      
      if (new Date() > new Date(data.expiresAt)) {
        await deleteDoc(otpRef);
        return res.status(400).json(createErrorResponse('Verification code has expired'));
      }

      if (data.otp !== otp) {
        return res.status(400).json(createErrorResponse('Invalid verification code'));
      }

      // Valid OTP - Clean up
      await deleteDoc(otpRef);

      // Check if user exists
      const usersRef = collection(db, 'users');
      const q = query(usersRef, where(email ? 'email' : 'phone', '==', identifier), limit(1));
      const userSnap = await getDocs(q);

      if (userSnap.empty) {
        // Not a user yet - return success but indicate registration needed
        return res.status(200).json(createSuccessResponse({ 
            verified: true, 
            newUser: true,
            identifier 
        }, 'Verified. Please complete registration.'));
      }

      const userData = userSnap.docs[0].data();
      
      // Fetch Agency details for name
      const agencyRef = doc(db, 'agencies', userData.agencyId);
      const agencySnap = await getDoc(agencyRef);
      const agencyName = agencySnap.exists() ? agencySnap.data().name : 'KodiPay';

      // Generate Session Token (JWT)
      const token = jwt.sign({
        uid: userData.uid,
        email: userData.email,
        phone: userData.phone,
        agencyId: userData.agencyId,
        agencyName: agencyName, // Added agencyName
        role: userData.role
      }, JWT_SECRET, { expiresIn: '7d' });

      res.status(200).json(createSuccessResponse({
        verified: true,
        newUser: false,
        token,
        user: { ...userData, agencyName } // Added agencyName
      }, 'Logged in successfully'));

    } catch (error) {
      console.error('❌ OTP Verification Error:', error.message);
      res.status(500).json(createErrorResponse('Verification failed', error.message));
    }
  }

  /**
   * Complete Signup (Passwordless)
   */
  async completeSignup(req, res) {
    try {
      const { email, phone, agencyName, fullName } = req.body;
      const identifier = email || phone;

      if (!identifier || !agencyName) {
        return res.status(400).json(createErrorResponse('Missing required signup fields'));
      }

      // Check if user already exists to prevent duplicates
      const usersRef = collection(db, 'users');
      const q = query(usersRef, where(email ? 'email' : 'phone', '==', identifier), limit(1));
      const existingUser = await getDocs(q);
      
      if (!existingUser.empty) {
        return res.status(400).json(createErrorResponse('Account already exists. Please sign in.'));
      }

      // 1. Create Agency
      const agencyRef = doc(collection(db, 'agencies'));
      const agencyId = agencyRef.id;

      await setDoc(agencyRef, {
        name: agencyName,
        smsStats: {
          monthlySent: 0,
          monthlyLimit: 20, // Trial SMS Limit
          totalSent: 0,
          lastResetDate: new Date().toISOString()
        },
        subscription: {
          activePlan: 'starter_trial',
          status: 'trial',
          propertiesLimit: 1, // Trial Properties Limit
          unitsLimit: 10
        },
        settings: {
          currency: 'KES',
          timezone: 'Africa/Nairobi'
        },
        createdAt: new Date().toISOString()
      });

      // 2. Create Default Settings document (Required for Superadmin visibility and agency customization)
      const settingsRef = doc(db, 'settings', agencyId);
      await setDoc(settingsRef, {
        agencyName: agencyName,
        businessName: agencyName,
        agencyPlan: 'starter_trial',
        accountStatus: 'Active',
        paybill: 'None',
        customerServiceNumber: phone || '',
        email: email || '',
        defaultCurrency: 'KES',
        timezone: 'Africa/Nairobi',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // 3. Create User Profile
      const uid = 'kp_' + Math.random().toString(36).substr(2, 9);
      const userRef = doc(db, 'users', uid);
      
      const userData = {
        uid,
        email: email || null,
        phone: phone || null,
        name: fullName || identifier.split('@')[0],
        role: 'admin',
        agencyId: agencyId,
        createdAt: new Date().toISOString()
      };

      await setDoc(userRef, userData);

      // 3. Generate Token
      const token = jwt.sign({
        uid,
        email: userData.email,
        phone: userData.phone,
        agencyId,
        agencyName: agencyName, // Added agencyName
        role: 'admin'
      }, JWT_SECRET, { expiresIn: '7d' });

      res.status(201).json(createSuccessResponse({
        token,
        user: { ...userData, agencyName }, // Added agencyName
        agencyId,
        role: 'admin'
      }, 'Onboarding completed successfully'));

    } catch (error) {
      console.error('❌ Signup Completion Error:', error.message);
      res.status(500).json(createErrorResponse('Failed to complete onboarding', error.message));
    }
  }
}

module.exports = new AuthController();
