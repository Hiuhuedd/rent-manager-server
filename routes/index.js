// ============================================
// FILE: src/routes/index.js
// ============================================
const express = require('express');
const router = express.Router();

const propertyRoutes = require('./propertyRoutes');
const tenantRoutes = require('./tenantRoutes');
const paymentRoutes = require('./paymentRoutes');
const webhookRoutes = require('./webhookRoutes');
const statsRoutes = require('./statsRoutes');
const settingsRoutes = require('./settingsRoutes');
const runningCostRoutes = require('./runningCostRoutes');
const reportRoutes = require('./reportRoutes');

router.use('/properties', propertyRoutes);
router.use('/tenants', tenantRoutes);
router.use('/payments', paymentRoutes);
router.use('/webhook', webhookRoutes);
router.use('/stats', statsRoutes);
router.use('/settings', settingsRoutes);
router.use('/running-costs', runningCostRoutes);
router.use('/reports', reportRoutes);

module.exports = router;