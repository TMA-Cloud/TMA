const express = require('express');
const { getPublicSignupStatus } = require('../controllers/user.controller');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');

const router = express.Router();

router.use(apiRateLimiter); // Apply rate limiting to public routes too

router.get('/signup-status', getPublicSignupStatus);

module.exports = router;
