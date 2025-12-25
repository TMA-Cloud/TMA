const express = require('express');
const auth = require('../middleware/auth.middleware');
const {
  storageUsage,
  getSignupStatus,
  toggleSignup,
  listUsers,
  getCustomDriveSettings,
  updateCustomDriveSettings,
  getAllUsersCustomDriveSettings,
} = require('../controllers/user.controller');

const router = express.Router();

router.use(auth);

router.get('/storage', storageUsage);
router.get('/signup-status', getSignupStatus);
router.post('/signup-toggle', toggleSignup);
router.get('/all', listUsers);
router.get('/custom-drive/all', getAllUsersCustomDriveSettings);
router.get('/custom-drive', getCustomDriveSettings);
router.put('/custom-drive', updateCustomDriveSettings);

module.exports = router;
