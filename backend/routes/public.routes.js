import express from 'express';

import { getPublicSignupStatus } from '../controllers/user.controller.js';
import { apiRateLimiter } from '../middleware/rateLimit.middleware.js';

const router = express.Router();

router.use(apiRateLimiter); // Apply rate limiting to public routes too

router.get('/signup-status', getPublicSignupStatus);

export default router;
