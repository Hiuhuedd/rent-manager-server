const axios = require('axios');
const { db } = require('../config/firebase');
const { collection, query, where, getDocs, limit, doc, getDoc } = require('firebase/firestore');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'kodipay_secret_2026_xyz';

/**
 * Authentication middleware to verify either Firebase ID tokens 
 * OR KodiPay custom JWTs (for passwordless flow).
 */
const authMiddleware = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: No token provided'
    });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    let decoded;
    
    // 1. Try verifying as our custom JWT first
    try {
      decoded = jwt.verify(token, JWT_SECRET);
      
      // For subagents, we must check if they are still active in Firestore
      if (decoded.role === 'subagent') {
        const userRef = doc(db, 'users', decoded.uid);
        const userSnap = await getDoc(userRef);
        const userData = userSnap.data();
        if (!userSnap.exists() || userData.status === 'inactive' || userData.active === false) {
          return res.status(403).json({ success: false, error: 'Account disabled' });
        }
        // Always use the latest assignments from the DB, not the potentially stale token
        decoded.assignedProperties = userData.assignedProperties || [];
      }

      req.user = decoded;
      console.log(`🔐 Authenticated (JWT): ${req.user.email || req.user.phone} (${req.user.role})`);
      return next();
    } catch (jwtErr) {
      // Not a valid custom JWT, fall back to Firebase token check
      console.log('--- Not a custom JWT, checking Firebase token ---');
    }

    // 2. Fallback: Verify token via Firebase REST API
    const apiKey = process.env.FIREBASE_API_KEY;
    const response = await axios.post(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      { idToken: token }
    );

    if (!response.data.users || response.data.users.length === 0) {
      throw new Error('Invalid token');
    }

    const firebaseUser = response.data.users[0];
    const uid = firebaseUser.localId;

    // 3. Fetch user profile from Firestore
    const usersRef = collection(db, 'users');
    const q = query(usersRef, where('uid', '==', uid), limit(1));
    const userSnap = await getDocs(q);

    if (userSnap.empty) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: User profile not found. Please complete registration.'
      });
    }

    const userData = userSnap.docs[0].data();
    
    req.user = {
      uid: uid,
      email: firebaseUser.email,
      role: userData.role || 'subagent',
      agencyId: userData.agencyId,
      assignedProperties: userData.assignedProperties || []
    };

    console.log(`🔐 Authenticated (Firebase): ${req.user.email} (${req.user.role})`);
    next();
  } catch (error) {
    console.error('❌ Auth Middleware Error:', error.response?.data?.error?.message || error.message);
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or expired token'
    });
  }
};

const adminOnly = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    return next();
  }
  return res.status(403).json({
    success: false,
    error: 'Forbidden: Admin access required'
  });
};

module.exports = {
  authMiddleware,
  adminOnly
};
