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
            const { paybill } = req.body;

            if (!paybill || typeof paybill !== 'string') {
                return res.status(400).json({
                    success: false,
                    error: 'Paybill number is required and must be a string',
                });
            }

            const settings = await settingsService.updateSettings({ paybill });
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
