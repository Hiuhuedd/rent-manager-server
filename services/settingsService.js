// ============================================
// FILE: src/services/settingsService.js
// ============================================
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, serverTimestamp } = require('firebase/firestore');

const SETTINGS_DOC_ID = 'app-settings';

class SettingsService {
    async getSettings() {
        try {
            const settingsRef = doc(db, 'settings', SETTINGS_DOC_ID);
            const settingsSnap = await getDoc(settingsRef);

            if (!settingsSnap.exists()) {
                return {
                    paybill: '522533',
                    paymentMethod: 'mpesa',
                    customerServiceNumber: '',
                    reminderConfig: { dayOfMonth: 15, time: '14:10' },
                    updatedAt: null,
                };
            }

            const data = settingsSnap.data();
            return {
                paybill: data.paybill || '522533',
                paymentMethod: data.paymentMethod || 'mpesa',
                customerServiceNumber: data.customerServiceNumber || '',
                reminderConfig: data.reminderConfig || { dayOfMonth: 15, time: '14:10' },
                updatedAt: data.updatedAt?.toDate?.() || null,
            };
        } catch (error) {
            console.error('[SettingsService] Error fetching settings:', error);
            throw error;
        }
    }

    async updateSettings(updates) {
        try {
            const settingsRef = doc(db, 'settings', SETTINGS_DOC_ID);

            const settingsData = {
                ...updates,
                updatedAt: serverTimestamp(),
            };

            await setDoc(settingsRef, settingsData, { merge: true });

            console.log('[SettingsService] Settings updated successfully');

            return {
                ...updates,
                updatedAt: new Date(),
            };
        } catch (error) {
            console.error('[SettingsService] Error updating settings:', error);
            throw error;
        }
    }
}

module.exports = new SettingsService();
