const express = require('express');
const router = express.Router();
const {
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
} = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');
const {
  authRateLimiter,
  mfaRateLimiter,
  backupCodeRegenerationRateLimiter,
  apiRateLimiter,
} = require('../middleware/rateLimit.middleware');

router.post('/signup', authRateLimiter, signup);
router.post('/login', authRateLimiter, login);
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

// MFA routes
router.get('/mfa/status', authMiddleware, apiRateLimiter, getMfaStatusController);
router.post('/mfa/setup', authMiddleware, apiRateLimiter, setupMfa);
router.post('/mfa/verify', authMiddleware, mfaRateLimiter, verifyAndEnableMfa);
router.post('/mfa/disable', authMiddleware, mfaRateLimiter, disableMfaController);
router.post('/mfa/backup-codes/regenerate', authMiddleware, backupCodeRegenerationRateLimiter, regenerateBackupCodes);
router.get('/mfa/backup-codes/count', authMiddleware, apiRateLimiter, getBackupCodesCount);

module.exports = router;
