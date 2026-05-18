const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');

// All admin routes require authentication and admin role
router.use(authMiddleware);
router.use(adminOnly);

router.get('/subagents', asyncHandler(adminController.getSubagents));
router.post('/subagents', asyncHandler(adminController.createSubagent));
router.put('/subagents', asyncHandler(adminController.updateSubagent));
router.post('/subagents/status', asyncHandler(adminController.toggleStatus));
router.delete('/subagents/:subagentUid', asyncHandler(adminController.deleteSubagent));
router.post('/subagents/assign', asyncHandler(adminController.assignProperty));
router.post('/subagents/unassign', asyncHandler(adminController.unassignProperty));
router.get('/staff-performance', asyncHandler(adminController.getStaffPerformance));

module.exports = router;
