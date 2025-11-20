  
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

router.use('/properties', propertyRoutes);
router.use('/tenants', tenantRoutes);
router.use('/payments', paymentRoutes);
router.use('/webhook', webhookRoutes);
router.use('/stats', statsRoutes);

module.exports = router;