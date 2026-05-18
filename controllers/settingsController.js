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
                onboardingCompleted
            } = req.body;

            const updates = {};
            if (agencyName !== undefined) updates.agencyName = agencyName;
            if (paybill !== undefined) updates.paybill = paybill;
            if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
            if (customerServiceNumber !== undefined) updates.customerServiceNumber = customerServiceNumber;
            if (reminderConfig !== undefined) updates.reminderConfig = reminderConfig;
            if (templates !== undefined) updates.templates = templates;
            if (onboardingCompleted !== undefined) updates.onboardingCompleted = onboardingCompleted;

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
}

module.exports = new SettingsController();
