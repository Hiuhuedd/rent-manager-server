// ============================================
// FILE: src/services/settingsService.js
// ============================================
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, serverTimestamp } = require('firebase/firestore');

const SETTINGS_DOC_ID = 'app-settings';

class SettingsService {
    /**
     * Get application settings
     * @returns {Promise<Object>} Settings object with paybill, etc.
     */
    async getSettings() {
        try {
            const settingsRef = doc(db, 'settings', SETTINGS_DOC_ID);
            const settingsSnap = await getDoc(settingsRef);

            if (!settingsSnap.exists()) {
                // Return default settings if not configured
                return {
                    paybill: '522533', // Default paybill
                    updatedAt: null,
                };
            }

            const data = settingsSnap.data();
            return {
                paybill: data.paybill || '522533',
                updatedAt: data.updatedAt?.toDate?.() || null,
            };
        } catch (error) {
            console.error('[SettingsService] Error fetching settings:', error);
            throw error;
        }
    }

    /**
     * Update application settings
     * @param {Object} updates - Settings to update
     * @param {string} updates.paybill - Paybill number
     * @returns {Promise<Object>} Updated settings
     */
    async updateSettings(updates) {
        try {
            const settingsRef = doc(db, 'settings', SETTINGS_DOC_ID);

            const settingsData = {
                ...updates,
                updatedAt: serverTimestamp(),
            };

            await setDoc(settingsRef, settingsData, { merge: true });

            console.log('[SettingsService] Settings updated successfully');

            // Return the updated settings (without timestamp since it's server-side)
            return {
                paybill: updates.paybill,
                updatedAt: new Date(),
            };
        } catch (error) {
            console.error('[SettingsService] Error updating settings:', error);
            throw error;
        }
    }
}

module.exports = new SettingsService();
