// ============================================
// FILE: src/services/settingsService.js
// ============================================
const { db } = require('../config/firebase');
const { doc, getDoc, setDoc, serverTimestamp, collection, query, where, getDocs } = require('firebase/firestore');

class SettingsService {
    /**
     * Get settings for a specific agency
     * @param {string} agencyId - Agency ID
     */
    async getSettings(agencyId = 'app-settings') {
        try {
            const settingsRef = doc(db, 'settings', agencyId);
            const settingsSnap = await getDoc(settingsRef);

            let agencyName = '';
            let smsQuotaUsed = 34;
            let smsQuotaTotal = 1500;
            let agencyPlan = 'starter';

            try {
                const agencyRef = doc(db, 'agencies', agencyId);
                const agencySnap = await getDoc(agencyRef);
                if (agencySnap.exists()) {
                    const agencyData = agencySnap.data();
                    agencyName = agencyData.name || '';
                    if (agencyData.smsStats) {
                        smsQuotaUsed = agencyData.smsStats.monthlySent !== undefined ? agencyData.smsStats.monthlySent : 34;
                        smsQuotaTotal = agencyData.smsStats.monthlyLimit !== undefined ? agencyData.smsStats.monthlyLimit : 1500;
                    }
                    if (agencyData.subscription) {
                        agencyPlan = agencyData.subscription.activePlan || 'starter';
                    }
                }
            } catch (e) {
                console.error('[SettingsService] Failed to fetch agency metrics:', e);
            }

            if (!settingsSnap.exists()) {
                return {
                    agencyName: agencyName || 'Mwaura properties',
                    paybill: '522533',
                    paymentMethod: 'mpesa',
                    customerServiceNumber: '',
                    reminderConfig: { dayOfMonth: 15, time: '14:10' },
                    
                    defaultCurrency: 'KES',
                    timezone: 'Africa/Nairobi',
                    brandAccent: 'amber',
                    paymentMethods: null,
                    smsTemplates: null,
                    penalties: null,
                    defaultCommissionRate: '10',
                    agencyPlan: agencyPlan || 'starter',
                    smsQuotaUsed: smsQuotaUsed,
                    smsQuotaTotal: smsQuotaTotal,
                    rentDueDay: 5,
                    
                    integrationTier: 'manual',
                    mpesaCredentials: {
                        consumerKey: '',
                        consumerSecret: '',
                        passkey: '',
                        shortCode: '',
                        initiatorName: '',
                        securityCredential: ''
                    },
                    payoutRouting: 'manual',
                    
                    updatedAt: null,
                };
            }

            const data = settingsSnap.data();
            return {
                agencyName: data.agencyName && data.agencyName !== 'KodiPay Agency' ? data.agencyName : (agencyName || 'Mwaura properties'),
                paybill: data.paybill || '522533',
                paymentMethod: data.paymentMethod || 'mpesa',
                customerServiceNumber: data.customerServiceNumber || '',
                reminderConfig: data.reminderConfig || { dayOfMonth: 15, time: '14:10' },
                
                defaultCurrency: data.defaultCurrency || 'KES',
                timezone: data.timezone || 'Africa/Nairobi',
                brandAccent: data.brandAccent || 'amber',
                paymentMethods: data.paymentMethods || {
                    mpesaActive: (data.paymentMethod === 'mpesa' || data.paymentMethod === undefined),
                    mpesaType: 'paybill',
                    mpesaNumber: data.paybill || '522533',
                    bankActive: false,
                    bankName: 'Equity Bank',
                    bankBranch: '',
                    bankAccountNumber: '',
                    cashActive: (data.paymentMethod === 'cash' || data.paymentMethod === undefined)
                },
                smsTemplates: data.smsTemplates || null,
                penalties: data.penalties || null,
                defaultCommissionRate: data.defaultCommissionRate || '10',
                agencyPlan: data.agencyPlan || agencyPlan || 'starter',
                smsQuotaUsed: data.smsQuotaUsed !== undefined ? data.smsQuotaUsed : smsQuotaUsed,
                smsQuotaTotal: data.smsQuotaTotal !== undefined ? data.smsQuotaTotal : smsQuotaTotal,
                rentDueDay: data.rentDueDay || 5,
                
                integrationTier: data.integrationTier || 'manual',
                mpesaCredentials: data.mpesaCredentials || {
                    consumerKey: '',
                    consumerSecret: '',
                    passkey: '',
                    shortCode: '',
                    initiatorName: '',
                    securityCredential: ''
                },
                payoutRouting: data.payoutRouting || 'manual',
                agencyPrefix: data.agencyPrefix || agencyId.substring(0, 5).toUpperCase(),
                
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

    /**
     * Find agency by their dedicated M-Pesa Shortcode
     * @param {string} shortCode
     */
    async findAgencyByShortCode(shortCode) {
        try {
            const settingsQuery = query(
                collection(db, 'settings'),
                where('integrationTier', '==', 'dedicated_mpesa'),
                where('mpesaCredentials.shortCode', '==', shortCode)
            );
            const snapshot = await getDocs(settingsQuery);
            if (!snapshot.empty) {
                return snapshot.docs[0].id; // Returns agencyId
            }
            return null;
        } catch (error) {
            console.error(`[SettingsService] Error finding agency by shortcode ${shortCode}:`, error);
            throw error;
        }
    }

    /**
     * Find agency by checking if a tenant exists with the matching M-Pesa phone number
     * @param {string} phoneNumber - The phone number used as BillRefNumber
     */
    async findAgencyByTenantPhone(phoneNumber) {
        if (!phoneNumber) return null;
        try {
            // Phone numbers in M-Pesa usually start with 254 or 0.
            // We normalize the BillRefNumber to 07... format for consistent lookup
            let normalized = phoneNumber.toString().trim();
            if (normalized.startsWith('254')) normalized = '0' + normalized.substring(3);
            else if (normalized.startsWith('+254')) normalized = '0' + normalized.substring(4);

            const tenantsQuery = query(
                collection(db, 'tenants'),
                where('phone', '==', normalized)
            );
            
            const snapshot = await getDocs(tenantsQuery);
            if (!snapshot.empty) {
                const tenantData = snapshot.docs[0].data();
                return tenantData.agencyId;
            }
            
            // Fallback: match exactly as typed by tenant
            const exactQuery = query(collection(db, 'tenants'), where('phone', '==', phoneNumber.toString().trim()));
            const exactSnap = await getDocs(exactQuery);
            if (!exactSnap.empty) {
                return exactSnap.docs[0].data().agencyId;
            }

            return null;
        } catch (error) {
            console.error(`[SettingsService] Error finding agency by tenant phone ${phoneNumber}:`, error);
            throw error;
        }
    }
}

module.exports = new SettingsService();
