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
} = require('../controllers/auth.controller');
const authMiddleware = require('../middleware/auth.middleware');
const { authRateLimiter } = require('../middleware/rateLimit.middleware');

router.post('/signup', authRateLimiter, signup);
router.post('/login', authRateLimiter, login);
router.get('/google/enabled', (req, res) => {
  res.json({ enabled: googleAuthEnabled });
});
if (googleAuthEnabled) {
  router.get('/google/login', googleLogin);
  router.get('/google/callback', googleCallback);
}
router.post('/logout', logout);
router.post('/logout-all', authMiddleware, logoutAllDevices);
router.get('/profile', authMiddleware, profile);
router.get('/sessions', authMiddleware, getSessions);
router.delete('/sessions/:sessionId', authMiddleware, revokeSession);
router.post('/sessions/revoke-others', authMiddleware, revokeOtherSessions);

// MFA routes
router.get('/mfa/status', authMiddleware, getMfaStatusController);
router.post('/mfa/setup', authMiddleware, setupMfa);
router.post('/mfa/verify', authMiddleware, verifyAndEnableMfa);
router.post('/mfa/disable', authMiddleware, disableMfaController);

module.exports = router;
