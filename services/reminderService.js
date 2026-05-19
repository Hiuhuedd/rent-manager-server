// ============================================
// FILE: src/services/reminderService.js
// ============================================
const { db } = require('../config/firebase');
const { collection, getDocs } = require('firebase/firestore');
const settingsService = require('./settingsService');
const smsService = require('./smsService');

class ReminderService {
    /**
     * Send payment reminders to active tenants (optionally filtered by filterAgencyId)
     * @param {string} [filterAgencyId=null] - Optional agency ID to filter by
     * @returns {Promise<Object>} Result with success status and count
     */
    async sendPaymentReminders(filterAgencyId = null) {
        try {
            console.log(`🔔 Starting payment reminder process${filterAgencyId ? ` for agency ${filterAgencyId}` : ''}...`);

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
            const agencySettingsCache = {};

            for (const tenantDoc of tenantsSnap.docs) {
                const tenant = tenantDoc.data();
                const agencyId = tenant.agencyId || 'app-settings';

                // If filterAgencyId is provided, filter by it
                if (filterAgencyId && agencyId !== filterAgencyId) {
                    continue;
                }

                // Skip if no phone number
                if (!tenant.phone) {
                    console.log(`   Skipping tenant ${tenant.name} (no phone)`);
                    continue;
                }

                try {
                    // Fetch settings for this specific agency (with simple cache)
                    if (!agencySettingsCache[agencyId]) {
                        agencySettingsCache[agencyId] = await settingsService.getSettings(agencyId);
                    }
                    const settings = agencySettingsCache[agencyId];
                    const paybill = settings.paybill || '522533';

                    // Generate reminder SMS
                    const message = this.generateReminderMessage(tenant, settings);

                    // Send SMS
                    await smsService.sendSMS(
                        tenant.phone,
                        message,
                        agencyId,
                        'system_reminder',
                        tenantDoc.id
                    );

                    sentCount++;
                    console.log(`   ✅ Sent reminder to ${tenant.name} (${tenant.phone}) for agency ${agencyId}`);
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
     * Generate reminder message for a tenant using custom templates and active payment configurations
     * @param {Object} tenant - Tenant data
     * @param {Object} settings - Agency settings object
     * @returns {string} SMS message
     */
    generateReminderMessage(tenant, settings = {}) {
        const name = tenant.name || 'Tenant';
        const unitCode = tenant.unitCode || '';
        const rentAmount = tenant.rentAmount || 0;
        const arrears = tenant.arrears || 0;
        const accountNumber = tenant.phone?.trim().startsWith('0')
            ? tenant.phone.trim()
            : `0${tenant.phone.trim().replace(/^\+254/, '').replace(/^254/, '')}`;

        // Use arrears if available, otherwise fall back to rent amount
        const amountDue = arrears > 0 ? arrears : rentAmount;

        // 1. Build dynamic payment instructions string based on active payment methods
        let paybillString = '';
        const methods = settings.paymentMethods || {};
        const activeMethods = [];

        if (methods.mpesaActive) {
            const channelType = methods.mpesaType === 'till' ? 'Till' : 'Paybill';
            activeMethods.push(`M-Pesa ${channelType} ${methods.mpesaNumber || settings.paybill || '522533'}`);
        }
        if (methods.bankActive) {
            activeMethods.push(`${methods.bankName || 'Bank'} A/C ${methods.bankAccountNumber || ''} (Name: ${methods.bankBranch || ''})`);
        }
        if (methods.cashActive && activeMethods.length === 0) {
            activeMethods.push('Cash remittance');
        }

        if (activeMethods.length > 0) {
            paybillString = activeMethods.join(' or ');
        } else {
            paybillString = `Paybill ${settings.paybill || '522533'}`;
        }

        // 2. Select the template (custom from Settings, or our sleek minimal default)
        const template = settings.smsTemplates?.rentDue || 
            'Dear {tenantName}, rent for {propertyName} unit {unitName} is due. Please pay KSh {amount} via {paybill}. Support: {customerServiceNumber}';

        // 3. Perform placeholders replacement
        const message = template
            .replace(/{tenantName}/g, name)
            .replace(/{propertyName}/g, tenant.propertyName || tenant.propertyCode || 'your building')
            .replace(/{unitCode}/g, unitCode)
            .replace(/{unitName}/g, unitCode) // Support both wildcards {unitName} and {unitCode}
            .replace(/{amount}/g, amountDue.toLocaleString())
            .replace(/{paybill}/g, paybillString)
            .replace(/{customerServiceNumber}/g, settings.customerServiceNumber || '+254 700 123 456');

        return message;
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
