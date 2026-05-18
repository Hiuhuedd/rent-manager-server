// ============================================
// FILE: src/routes/index.js
// ============================================
const express = require('express');
const router = express.Router();

console.log('🔌 Main Router Initializing...');

const propertyRoutes = require('./propertyRoutes');
const tenantRoutes = require('./tenantRoutes');
const paymentRoutes = require('./paymentRoutes');
const webhookRoutes = require('./webhookRoutes');
const statsRoutes = require('./statsRoutes');
const settingsRoutes = require('./settingsRoutes');
const runningCostRoutes = require('./runningCostRoutes');
const reportRoutes = require('./reportRoutes');
const waterBillRoutes = require('./waterBillRoutes');
const electricityBillRoutes = require('./electricityBillRoutes');
const adminRoutes = require('./adminRoutes');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');

const billingRoutes = require('./billingRoutes');

router.use('/properties', propertyRoutes);
router.use('/tenants', tenantRoutes);
router.use('/payments', paymentRoutes);
router.use('/webhook', webhookRoutes);
router.use('/stats', statsRoutes);
router.use('/settings', settingsRoutes);
router.use('/running-costs', runningCostRoutes);
router.use('/reports', reportRoutes);
router.use('/water-bills', waterBillRoutes);
router.use('/electricity-bills', electricityBillRoutes);
router.use('/admin', adminRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/billing', billingRoutes);

module.exports = router;