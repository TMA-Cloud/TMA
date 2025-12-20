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
  googleAuthEnabled
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

module.exports = router;
