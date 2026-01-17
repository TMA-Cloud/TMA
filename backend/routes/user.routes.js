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
  checkOnlyOfficeConfigured,
  getOnlyOfficeConfig,
  updateOnlyOfficeConfig,
  getAgentConfig,
  updateAgentConfig,
  getAgentPaths,
  checkAgentStatus,
  resetAgentStatus,
  updateUserStorageLimit,
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
router.get('/onlyoffice-configured', checkOnlyOfficeConfigured);
router.get('/onlyoffice-config', getOnlyOfficeConfig);
router.put('/onlyoffice-config', updateOnlyOfficeConfig);
router.get('/agent-config', getAgentConfig);
router.put('/agent-config', updateAgentConfig);
router.get('/agent-paths', getAgentPaths);
router.get('/agent-status', checkAgentStatus);
router.post('/agent-refresh', resetAgentStatus);
router.put('/storage-limit', updateUserStorageLimit);

module.exports = router;
