// ============================================
// FILE: src/controllers/settingsController.js
// ============================================
const settingsService = require('../services/settingsService');
const { createSuccessResponse } = require('../utils/responseHelper');

class SettingsController {
    async getSettings(req, res) {
        try {
            const settings = await settingsService.getSettings();
            res.json(createSuccessResponse(settings));
        } catch (error) {
            console.error('[SettingsController] Error getting settings:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to retrieve settings',
            });
        }
    }

    async updateSettings(req, res) {
        try {
            const { paybill, paymentMethod, customerServiceNumber, reminderConfig } = req.body;

            const updates = {};
            if (paybill !== undefined) updates.paybill = paybill;
            if (paymentMethod !== undefined) updates.paymentMethod = paymentMethod;
            if (customerServiceNumber !== undefined) updates.customerServiceNumber = customerServiceNumber;
            if (reminderConfig !== undefined) updates.reminderConfig = reminderConfig;

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({
                    success: false,
                    error: 'No valid settings provided to update',
                });
            }

            const settings = await settingsService.updateSettings(updates);
            res.json(createSuccessResponse(settings, 'Settings updated successfully'));
        } catch (error) {
            console.error('[SettingsController] Error updating settings:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to update settings',
            });
        }
    }
}

module.exports = new SettingsController();
