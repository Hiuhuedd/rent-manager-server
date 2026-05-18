const { db } = require('../config/firebase');
const { doc, getDoc, updateDoc, increment, collection, getDocs, writeBatch } = require('firebase/firestore');

class SMSQuotaService {
  /**
   * Calculate how many SMS units a message consumes
   * 1-160 chars = 1 unit
   * > 160 chars = Math.ceil(length / 153) units (Standard SMPP/GSM behavior)
   * For simplicity and to match the user's "1000 sms" logic, we'll use 160 as the base.
   * @param {string} message 
   * @returns {number}
   */
  calculateUnits(message) {
    if (!message) return 0;
    const length = message.length;
    if (length <= 160) return 1;
    // When messages are concatenated, they use 7 bytes for the User Data Header (UDH)
    // reducing the characters per part to 153.
    return Math.ceil(length / 153);
  }

  /**
   * Check if an agency has enough quota to send the requested number of units
   * @param {string} agencyId 
   * @param {number} requestedUnits 
   * @returns {Promise<{canSend: boolean, reason?: string, stats?: object}>}
   */
  async checkQuota(agencyId, requestedUnits) {
    try {
      const stats = await this.getQuotaStats(agencyId);
      const currentMonthly = stats.monthlySent || 0;
      const limit = stats.monthlyLimit || 2000;

      if (currentMonthly + requestedUnits > limit) {
        return {
          canSend: false,
          reason: `Monthly SMS limit reached (${currentMonthly}/${limit}). Please purchase a bundle.`,
          stats
        };
      }

      return { canSend: true, stats };
    } catch (error) {
      console.error('❌ Error checking SMS quota:', error.message);
      return { canSend: true, error: error.message }; 
    }
  }

  /**
   * Get current quota stats for an agency
   * @param {string} agencyId 
   */
  async getQuotaStats(agencyId) {
    const agencyRef = doc(db, 'agencies', agencyId);
    const agencySnap = await getDoc(agencyRef);
    
    if (!agencySnap.exists()) {
      return { 
        monthlySent: 0, 
        monthlyLimit: 2000, 
        totalSent: 0,
        subscription: { activePlan: 'starter_trial', status: 'trial', propertiesLimit: 2, unitsLimit: 10 }
      };
    }
    
    const data = agencySnap.data();
    const smsStats = data.smsStats || { monthlySent: 0, monthlyLimit: 2000, totalSent: 0 };
    
    return {
      ...smsStats,
      subscription: data.subscription || { activePlan: 'starter_trial', status: 'trial', propertiesLimit: 2, unitsLimit: 10 }
    };
  }

  /**
   * Update the monthly limit for an agency
   * @param {string} agencyId 
   * @param {number} newLimit 
   */
  async updateLimit(agencyId, newLimit) {
    const agencyRef = doc(db, 'agencies', agencyId);
    await updateDoc(agencyRef, {
      'smsStats.monthlyLimit': newLimit,
      'smsStats.updatedAt': new Date().toISOString()
    });
  }

  /**
   * Atomically increment SMS usage for an agency
   * @param {string} agencyId 
   * @param {number} units 
   */
  async incrementUsage(agencyId, units) {
    try {
      const agencyRef = doc(db, 'agencies', agencyId);
      
      await updateDoc(agencyRef, {
        'smsStats.monthlySent': increment(units),
        'smsStats.totalSent': increment(units),
        'smsStats.lastUsedAt': new Date().toISOString()
      });
      
      console.log(`📈 SMS Quota updated for ${agencyId}: +${units} units`);
    } catch (error) {
      console.error(`❌ Failed to increment SMS usage for ${agencyId}:`, error.message);
    }
  }

  /**
   * Reset monthly counters for all agencies
   * This should be called by a cron job on the 1st of every month
   */
  async resetMonthlyQuotas() {
    console.log('♻️ Resetting monthly SMS quotas for all agencies...');
    try {
      const agenciesSnap = await getDocs(collection(db, 'agencies'));
      const batch = writeBatch(db);
      
      let count = 0;
      agenciesSnap.forEach(agencyDoc => {
        batch.update(agencyDoc.ref, {
          'smsStats.monthlySent': 0,
          'smsStats.lastResetDate': new Date().toISOString()
        });
        count++;
      });
      
      await batch.commit();
      console.log(`✅ Successfully reset quotas for ${count} agencies.`);
      return { success: true, count };
    } catch (error) {
      console.error('❌ Error resetting monthly quotas:', error.message);
      return { success: false, error: error.message };
    }
  }
}

module.exports = new SMSQuotaService();
