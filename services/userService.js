const { db } = require('../config/firebase');
const { 
  collection, doc, getDoc, getDocs, setDoc, deleteDoc,
  query, where, updateDoc, 
  arrayUnion, arrayRemove, limit
} = require('firebase/firestore');

class UserService {
  /**
   * Get all subagents for an agency
   * @param {string} agencyId 
   */
  async getSubagents(agencyId) {
    const usersRef = collection(db, 'users');
    const q = query(
      usersRef, 
      where('agencyId', '==', agencyId),
      where('role', '==', 'subagent')
    );
    const snap = await getDocs(q);
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  }

  /**
   * Create a new subagent entry in Firestore
   * @param {Object} userData 
   */
  async createSubagent(userData) {
    const { email, phone, agencyId, name, location, nationalId, emergencyContact } = userData;
    
    if (!email && !phone) {
        throw new Error('Email or Phone is required for subagent');
    }

    // Check if user already exists by email or phone
    const usersRef = collection(db, 'users');
    let q;
    if (email) {
        q = query(usersRef, where('email', '==', email), limit(1));
    } else {
        q = query(usersRef, where('phone', '==', phone), limit(1));
    }
    
    const existing = await getDocs(q);
    if (!existing.empty) {
      throw new Error('User with this email/phone already exists');
    }

    const uid = 'kp_sub_' + Math.random().toString(36).substr(2, 9);
    
    const newUser = {
      uid: uid,
      name,
      email: email || null,
      phone: phone || null,
      location: location || '',
      nationalId: nationalId || '',
      emergencyContact: emergencyContact || '',
      role: 'subagent',
      agencyId,
      status: 'active',
      active: true,
      assignedProperties: [],
      createdAt: new Date().toISOString()
    };

    await setDoc(doc(db, 'users', uid), newUser);
    return newUser;
  }

  /**
   * Assign a property to a subagent
   * @param {string} subagentUid 
   * @param {string} propertyId 
   */
  async assignProperty(subagentUid, propertyId) {
    const userRef = doc(db, 'users', subagentUid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) throw new Error('Subagent not found');

    await updateDoc(userRef, {
      assignedProperties: arrayUnion(propertyId)
    });

    return { success: true };
  }

  /**
   * Remove a property from a subagent
   * @param {string} subagentUid 
   * @param {string} propertyId 
   */
  async unassignProperty(subagentUid, propertyId) {
    const userRef = doc(db, 'users', subagentUid);
    const userSnap = await getDoc(userRef);

    if (!userSnap.exists()) throw new Error('Subagent not found');

    await updateDoc(userRef, {
      assignedProperties: arrayRemove(propertyId)
    });

    return { success: true };
  }

  /**
   * Disable or Enable a subagent
   * @param {string} subagentUid 
   * @param {boolean} active 
   */
  async toggleSubagentStatus(subagentUid, status) {
    const userRef = doc(db, 'users', subagentUid);
    await updateDoc(userRef, { 
      status: status,
      active: status === 'active', // keep for legacy compatibility
      updatedAt: new Date().toISOString() 
    });
    return { uid: subagentUid, status };
  }

  async getUserByUid(uid) {
    const userRef = doc(db, 'users', uid);
    const userSnap = await getDoc(userRef);
    if (!userSnap.exists()) throw new Error('User not found');
    return { uid, ...userSnap.data() };
  }

  async updateUserProfile(uid, { name, phone, location, nationalId, emergencyContact }) {
    const userRef = doc(db, 'users', uid);
    const updates = { updatedAt: new Date().toISOString() };
    if (name) updates.name = name;
    if (phone) updates.phone = phone;
    if (location !== undefined) updates.location = location;
    if (nationalId !== undefined) updates.nationalId = nationalId;
    if (emergencyContact !== undefined) updates.emergencyContact = emergencyContact;
    
    await updateDoc(userRef, updates);
    return { uid, ...updates };
  }

  /**
   * Delete a subagent profile
   * @param {string} subagentUid 
   */
  async deleteSubagent(subagentUid) {
    const userRef = doc(db, 'users', subagentUid);
    await deleteDoc(userRef);
    return { success: true };
  }
}

module.exports = new UserService();
