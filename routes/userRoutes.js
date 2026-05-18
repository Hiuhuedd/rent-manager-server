const express = require('express');
const router = express.Router();
const userService = require('../services/userService');
const { authMiddleware } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

router.use(authMiddleware);

// Get current user profile
router.get('/profile', asyncHandler(async (req, res) => {
    const { uid } = req.user;
    const user = await userService.getUserByUid(uid);
    res.json(createSuccessResponse(user));
}));

// Update current user profile
router.put('/profile', asyncHandler(async (req, res) => {
    const { uid } = req.user;
    const { name, phone } = req.body;
    
    // We only allow updating name and phone via this endpoint
    const result = await userService.updateUserProfile(uid, { name, phone });
    res.json(createSuccessResponse(result, 'Profile updated successfully'));
}));

module.exports = router;
