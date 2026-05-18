// ============================================
// FILE: src/controllers/runningCostController.js
// ============================================
const runningCostService = require('../services/runningCostService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');
const { db } = require('../config/firebase');
const { doc, getDoc } = require('firebase/firestore');

class RunningCostController {
    async addCost(req, res) {
        try {
            const { propertyId, category, feeName, amount, description, date, unitId, unitName, unitCode } = req.body;
            const { agencyId } = req.user;

            if (!propertyId || !category || !feeName || !amount) {
                return res.status(400).json(createErrorResponse('Missing required fields: propertyId, category, feeName, amount'));
            }

            const result = await runningCostService.addCost({
                propertyId,
                agencyId,
                category,
                feeName,
                amount,
                description,
                date,
                unitId,
                unitName,
                unitCode,
                createdBy: req.user?.email || 'system',
            });

            res.json(createSuccessResponse(result, 'Running cost added successfully'));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }

    async getCostsByProperty(req, res) {
        try {
            const { propertyId } = req.params;
            const { agencyId } = req.user;
            const costs = await runningCostService.getCostsByProperty(propertyId, agencyId);
            res.json(createSuccessResponse({ costs }));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }

    async getAllCosts(req, res) {
        try {
            const { agencyId, assignedProperties, role } = req.user;
            const costs = await runningCostService.getAllCosts(
                agencyId,
                role === 'admin' ? [] : assignedProperties
            );
            res.json(createSuccessResponse({ costs }));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }

    async getCostsByPropertyAndMonth(req, res) {
        try {
            const { propertyId, month } = req.params;
            const { agencyId, assignedProperties, role } = req.user;
            const costs = propertyId === 'all'
                ? await runningCostService.getCostsByMonth(month, agencyId, role === 'admin' ? [] : assignedProperties)
                : await runningCostService.getCostsByPropertyAndMonth(propertyId, month, agencyId);
            res.json(createSuccessResponse({ costs }));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }

    async updateCost(req, res) {
        const { id } = req.params;
        const updates = req.body;
        const { agencyId } = req.user;

        try {
            // Safety: First check if record exists and belongs to agency
            const costRef = doc(db, 'runningCosts', id);
            const costSnap = await getDoc(costRef);
            
            if (!costSnap.exists()) {
                return res.status(404).json(createErrorResponse('Cost record not found'));
            }
            
            if (agencyId && costSnap.data().agencyId !== agencyId) {
                return res.status(403).json(createErrorResponse('Unauthorized: Cost record belongs to another agency'));
            }

            const result = await runningCostService.updateCost(id, updates);
            res.json(createSuccessResponse(result, 'Cost updated successfully'));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }

    async deleteCost(req, res) {
        const { id } = req.params;
        const { agencyId } = req.user;

        try {
            await runningCostService.deleteCost(id, agencyId);
            res.json(createSuccessResponse({ success: true }, 'Cost deleted successfully'));
        } catch (error) {
            res.status(403).json(createErrorResponse(error.message));
        }
    }

    async getTotalCostsByMonth(req, res) {
        try {
            const { propertyId, month } = req.params;
            const { agencyId } = req.user;
            const totals = await runningCostService.getTotalCostsByMonth(propertyId, month, agencyId);
            res.json(createSuccessResponse(totals));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }

    async addCostsBatch(req, res) {
        try {
            const { expenses } = req.body;
            const { agencyId } = req.user;

            if (!expenses || !Array.isArray(expenses) || expenses.length === 0) {
                return res.status(400).json(createErrorResponse('Missing or invalid "expenses" array in request body'));
            }

            // Validate all expenses
            for (const exp of expenses) {
                const { propertyId, category, feeName, amount } = exp;
                if (!propertyId || !category || !feeName || !amount) {
                    return res.status(400).json(createErrorResponse('Each expense must have propertyId, category, feeName, and amount'));
                }
            }

            const results = await Promise.all(expenses.map(async (exp) => {
                const { propertyId, category, feeName, amount, description, date, unitId, unitName, unitCode } = exp;
                return await runningCostService.addCost({
                    propertyId,
                    agencyId,
                    category,
                    feeName,
                    amount,
                    description,
                    date,
                    unitId,
                    unitName,
                    unitCode,
                    createdBy: req.user?.email || 'system',
                });
            }));

            res.json(createSuccessResponse({ expenses: results }, 'Running costs batch added successfully'));
        } catch (error) {
            res.status(500).json(createErrorResponse(error.message));
        }
    }
}

module.exports = new RunningCostController();
