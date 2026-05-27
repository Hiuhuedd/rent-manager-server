// ============================================
// FILE: src/controllers/settingsController.js
// ============================================
const settingsService = require('../services/settingsService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class SettingsController {
    async getSettings(req, res) {
        try {
            const { agencyId } = req.user;
            const settings = await settingsService.getSettings(agencyId);
            res.json(createSuccessResponse(settings));
        } catch (error) {
            console.error('[SettingsController] Error getting settings:', error);
            res.status(500).json(createErrorResponse('Failed to retrieve settings', error.message));
        }
    }

    async updateSettings(req, res) {
        try {
            const { agencyId } = req.user;
            const {
                agencyName,
                paybill,
                paymentMethod,
                customerServiceNumber,
                reminderConfig,
                templates,
                onboardingCompleted,
                
                defaultCurrency,
                timezone,
                brandAccent,
                paymentMethods,
                smsTemplates,
                penalties,
                defaultCommissionRate,
                agencyPlan,
                smsQuotaUsed,
                smsQuotaTotal,
                rentDueDay,
                integrationTier,
                mpesaCredentials,
                payoutRouting,
                agencyPrefix
            } = req.body;

            const updates = {};
            if (agencyName !== undefined) updates.agencyName = agencyName;
            if (paybill !== undefined) updates.paybill = paybill;
            if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
            if (customerServiceNumber !== undefined) updates.customerServiceNumber = customerServiceNumber;
            if (reminderConfig !== undefined) updates.reminderConfig = reminderConfig;
            if (templates !== undefined) updates.templates = templates;
            if (onboardingCompleted !== undefined) updates.onboardingCompleted = onboardingCompleted;
            
            if (defaultCurrency !== undefined) updates.defaultCurrency = defaultCurrency;
            if (timezone !== undefined) updates.timezone = timezone;
            if (brandAccent !== undefined) updates.brandAccent = brandAccent;
            if (paymentMethods !== undefined) updates.paymentMethods = paymentMethods;
            if (smsTemplates !== undefined) updates.smsTemplates = smsTemplates;
            if (penalties !== undefined) updates.penalties = penalties;
            if (defaultCommissionRate !== undefined) updates.defaultCommissionRate = defaultCommissionRate;
            if (agencyPlan !== undefined) updates.agencyPlan = agencyPlan;
            if (smsQuotaUsed !== undefined) updates.smsQuotaUsed = smsQuotaUsed;
            if (smsQuotaTotal !== undefined) updates.smsQuotaTotal = smsQuotaTotal;
            if (rentDueDay !== undefined) updates.rentDueDay = rentDueDay;
            if (integrationTier !== undefined) updates.integrationTier = integrationTier;
            if (mpesaCredentials !== undefined) updates.mpesaCredentials = mpesaCredentials;
            if (payoutRouting !== undefined) updates.payoutRouting = payoutRouting;
            if (agencyPrefix !== undefined) updates.agencyPrefix = agencyPrefix;

            if (Object.keys(updates).length === 0) {
                return res.status(400).json(createErrorResponse('No valid settings provided to update'));
            }

            const settings = await settingsService.updateSettings(agencyId, updates);
            res.json(createSuccessResponse(settings, 'Settings updated successfully'));
        } catch (error) {
            console.error('[SettingsController] Error updating settings:', error);
            res.status(500).json(createErrorResponse('Failed to update settings', error.message));
        }
    }

    async registerMpesaWebhooks(req, res) {
        try {
            const { agencyId } = req.user;
            const axios = require('axios');
            
            // 1. Fetch current settings for credentials
            const settings = await settingsService.getSettings(agencyId);
            const creds = settings.mpesaCredentials;

            if (!creds || !creds.consumerKey || !creds.consumerSecret || !creds.shortCode) {
                return res.status(400).json(createErrorResponse('Missing required M-Pesa credentials. Please configure Consumer Key, Consumer Secret, and Short Code first.'));
            }

            const isProd = process.env.NODE_ENV === 'production' || process.env.KODIPAY_MASTER_ENV === 'production';
            const baseUrl = isProd ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

            // 2. Generate Access Token using custom agency credentials
            const auth = Buffer.from(`${creds.consumerKey.trim()}:${creds.consumerSecret.trim()}`).toString('base64');
            const tokenResponse = await axios.get(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
                headers: { Authorization: `Basic ${auth}` }
            });
            const accessToken = tokenResponse.data.access_token;

            // 3. Register C2B URLs on Daraja
            const host = req.get('host');
            const scheme = req.protocol;
            const callbackBase = `${scheme}://${host}`;

            const payload = {
                ShortCode: creds.shortCode.trim(),
                ResponseType: 'Completed',
                ConfirmationURL: `${callbackBase}/api/webhook/gateway/confirmation`,
                ValidationURL: `${callbackBase}/api/webhook/gateway/validation`
            };

            console.log(`🔗 Dynamic Register URL for agency ${agencyId} (${creds.shortCode}) to ${callbackBase}`);
            const registerResponse = await axios.post(`${baseUrl}/mpesa/c2b/v2/registerurl`, payload, {
                headers: { Authorization: `Bearer ${accessToken}` }
            });

            res.json(createSuccessResponse(registerResponse.data, 'Daraja C2B webhooks registered successfully!'));
        } catch (error) {
            console.error('[SettingsController] Failed to register webhooks:', error.response?.data || error.message);
            const safaricomErr = error.response?.data;
            const errMsg = safaricomErr?.errorMessage || safaricomErr?.errorDescription || error.message;
            res.status(500).json(createErrorResponse(500, `Safaricom API Error: ${errMsg}`, safaricomErr));
        }
    }

    async getMpesaBalances(req, res) {
        try {
            const { agencyId } = req.user;
            const settings = await settingsService.getSettings(agencyId);
            if (settings && settings.liveMpesaBalances) {
                return res.json(createSuccessResponse(settings.liveMpesaBalances, 'Live M-Pesa balances fetched'));
            }
            return res.json(createSuccessResponse({ utility: 0, working: 0, isLive: false }, 'No live balances yet'));
        } catch (error) {
            console.error('[SettingsController] Failed to get mpesa balances:', error.message);
            res.status(500).json(createErrorResponse(500, 'Failed to fetch balances'));
        }
    }

        try {
            const { agencyId } = req.user;
            
            const settings = await settingsService.getSettings(agencyId);
            const creds = settings.mpesaCredentials;

            if (!creds || !creds.consumerKey || !creds.consumerSecret || !creds.shortCode) {
                return res.status(400).json(createErrorResponse('Missing required M-Pesa credentials. Cannot query balances.'));
            }

            const mpesaPayoutService = require('../services/payment/mpesaPayoutService');
            
            // This triggers the query asynchronously. Safaricom will reply to our webhook later.
            await mpesaPayoutService.queryAccountBalance(creds, agencyId);
            
            res.json(createSuccessResponse({}, 'Account balance query submitted to Safaricom successfully. Balances will update shortly.'));
        } catch (error) {
            console.error('[SettingsController] Failed to query account balances:', error.response?.data || error.message);
            const safaricomErr = error.response?.data;
            const errMsg = safaricomErr?.errorMessage || safaricomErr?.errorDescription || error.message;
            res.status(500).json(createErrorResponse(500, `Safaricom API Error: ${errMsg}`, safaricomErr));
        }
    }
}

module.exports = new SettingsController();
