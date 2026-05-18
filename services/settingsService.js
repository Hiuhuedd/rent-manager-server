// ============================================
// FILE: src/services/settingsService.js
// ============================================
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, serverTimestamp } = require('firebase/firestore');

class SettingsService {
    /**
     * Get settings for a specific agency
     * @param {string} agencyId - Agency ID
     */
    async getSettings(agencyId = 'app-settings') {
        try {
            const settingsRef = doc(db, 'settings', agencyId);
            const settingsSnap = await getDoc(settingsRef);

            if (!settingsSnap.exists()) {
                return {
                    agencyName: 'KodiPay Agency',
                    paybill: '522533',
                    paymentMethod: 'mpesa',
                    customerServiceNumber: '',
                    reminderConfig: { dayOfMonth: 15, time: '14:10' },
                    updatedAt: null,
                };
            }

            const data = settingsSnap.data();
            return {
                agencyName: data.agencyName || 'KodiPay Agency',
                paybill: data.paybill || '522533',
                paymentMethod: data.paymentMethod || 'mpesa',
                customerServiceNumber: data.customerServiceNumber || '',
                reminderConfig: data.reminderConfig || { dayOfMonth: 15, time: '14:10' },
                updatedAt: data.updatedAt?.toDate?.() || null,
            };
        } catch (error) {
            console.error(`[SettingsService] Error fetching settings for ${agencyId}:`, error);
            throw error;
        }
    }

    /**
     * Update settings for a specific agency
     * @param {string} agencyId - Agency ID
     * @param {Object} updates - Settings updates
     */
    async updateSettings(agencyId, updates) {
        if (!agencyId) throw new Error('Agency ID is required');

        try {
            const settingsRef = doc(db, 'settings', agencyId);

            const settingsData = {
                ...updates,
                updatedAt: serverTimestamp(),
            };

            await setDoc(settingsRef, settingsData, { merge: true });

            console.log(`[SettingsService] Settings updated successfully for agency: ${agencyId}`);

            return {
                ...updates,
                updatedAt: new Date(),
            };
        } catch (error) {
            console.error(`[SettingsService] Error updating settings for ${agencyId}:`, error);
            throw error;
        }
    }
}

module.exports = new SettingsService();
