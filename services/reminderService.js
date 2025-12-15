// ============================================
// FILE: src/services/reminderService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs } = require('firebase/firestore');
const settingsService = require('./settingsService');
const smsService = require('./smsService');

class ReminderService {
    /**
     * Send payment reminders to all active tenants
     * @returns {Promise<Object>} Result with success status and count
     */
    async sendPaymentReminders() {
        try {
            console.log('🔔 Starting payment reminder process...');

            // Fetch all tenants
            const tenantsRef = collection(db, 'tenants');
            const tenantsSnap = await getDocs(tenantsRef);

            if (tenantsSnap.empty) {
                console.log('   No tenants found');
                return { success: true, sentCount: 0 };
            }

            let sentCount = 0;
            let failedCount = 0;
            const errors = [];

            // Fetch settings for customer service number
            const settings = await settingsService.getSettings();
            const customerServiceNumber = settings.customerServiceNumber || '0113689071';
            const paybill = settings.paybill || '522533';

            for (const tenantDoc of tenantsSnap.docs) {
                const tenant = tenantDoc.data();

                // Skip if no phone number
                if (!tenant.phone) {
                    console.log(`   Skipping tenant ${tenant.name} (no phone)`);
                    continue;
                }

                try {
                    // Generate reminder SMS
                    const message = this.generateReminderMessage(tenant, paybill, customerServiceNumber);

                    // Send SMS
                    await smsService.sendSMS(
                        tenant.phone,
                        message,
                        `reminder_${tenantDoc.id}`,
                        { type: 'payment_reminder', tenantId: tenantDoc.id }
                    );

                    sentCount++;
                    console.log(`   ✅ Sent reminder to ${tenant.name} (${tenant.phone})`);
                } catch (error) {
                    failedCount++;
                    errors.push({ tenant: tenant.name, error: error.message });
                    console.error(`   ❌ Failed to send to ${tenant.name}:`, error.message);
                }
            }

            console.log(`✅ Reminder process complete: ${sentCount} sent, ${failedCount} failed`);

            return {
                success: true,
                sentCount,
                failedCount,
                errors: errors.length > 0 ? errors : undefined
            };
        } catch (error) {
            console.error('❌ Reminder service error:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    /**
     * Generate reminder message for a tenant
     * @param {Object} tenant - Tenant data
     * @param {string} paybill - Paybill number
     * @param {string} customerServiceNumber - Support number
     * @returns {string} SMS message
     */
    generateReminderMessage(tenant, paybill, customerServiceNumber) {
        const name = tenant.name || 'Tenant';
        const unitCode = tenant.unitCode || '';
        const rentAmount = tenant.rentAmount || 0;
        const accountNumber = tenant.phone?.trim().startsWith('0')
            ? tenant.phone.trim()
            : `0${tenant.phone.trim().replace(/^\+254/, '').replace(/^254/, '')}`;

        return `Hi ${name}, this is a reminder that your rent for ${unitCode} (KES ${rentAmount.toLocaleString()}) is due on the 1st. Pay via Paybill ${paybill}, Acc ${accountNumber}. Call ${customerServiceNumber} for assistance.`;
    }

    /**
     * Check if reminders should be sent today
     * @param {Object} reminderConfig - Config with dayOfMonth and time
     * @returns {boolean} True if reminders should be sent now
     */
    shouldSendReminders(reminderConfig) {
        const now = new Date();
        const currentDay = now.getDate();
        const currentHour = now.getHours();
        const currentMinute = now.getMinutes();

        // Parse configured time
        const [configHour, configMinute] = reminderConfig.time.split(':').map(Number);

        // Check if it's the right day
        if (currentDay !== reminderConfig.dayOfMonth) {
            return false;
        }

        // Check if it's the right time (within 1-minute window)
        const isRightHour = currentHour === configHour;
        const isRightMinute = Math.abs(currentMinute - configMinute) < 1;

        return isRightHour && isRightMinute;
    }
}

module.exports = new ReminderService();
