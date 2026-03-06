import express from 'express';

import {
  signup,
  login,
  googleLogin,
  googleCallback,
  logout,
  logoutAllDevices,
  profile,
  getSessions,
  revokeSession,
  revokeOtherSessions,
  googleAuthEnabled,
  setupMfa,
  verifyAndEnableMfa,
  disableMfaController,
  getMfaStatusController,
  regenerateBackupCodes,
  getBackupCodesCount,
  changePassword,
} from '../controllers/auth.controller.js';
import authMiddleware from '../middleware/auth.middleware.js';
import {
  authRateLimiter,
  mfaRateLimiter,
  backupCodeRegenerationRateLimiter,
  apiRateLimiter,
} from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { signupSchema, loginSchema, changePasswordSchema } from '../utils/validationSchemas.js';

const router = express.Router();

router.post('/signup', authRateLimiter, signupSchema, validate, signup);
router.post('/login', authRateLimiter, loginSchema, validate, login);
router.get('/google/enabled', (req, res) => {
  res.json({ enabled: googleAuthEnabled });
});
if (googleAuthEnabled) {
  router.get('/google/login', googleLogin);
  router.get('/google/callback', authRateLimiter, googleCallback);
}
router.post('/logout', apiRateLimiter, logout);
router.post('/logout-all', authMiddleware, apiRateLimiter, logoutAllDevices);
router.get('/profile', authMiddleware, apiRateLimiter, profile);
router.get('/sessions', authMiddleware, apiRateLimiter, getSessions);
router.delete('/sessions/:sessionId', authMiddleware, apiRateLimiter, revokeSession);
router.post('/sessions/revoke-others', authMiddleware, apiRateLimiter, revokeOtherSessions);
router.post('/change-password', authMiddleware, authRateLimiter, changePasswordSchema, validate, changePassword);

// MFA routes
router.get('/mfa/status', authMiddleware, apiRateLimiter, getMfaStatusController);
router.post('/mfa/setup', authMiddleware, apiRateLimiter, setupMfa);
router.post('/mfa/verify', authMiddleware, mfaRateLimiter, verifyAndEnableMfa);
router.post('/mfa/disable', authMiddleware, mfaRateLimiter, disableMfaController);
router.post('/mfa/backup-codes/regenerate', authMiddleware, backupCodeRegenerationRateLimiter, regenerateBackupCodes);
router.get('/mfa/backup-codes/count', authMiddleware, apiRateLimiter, getBackupCodesCount);

export default router;
