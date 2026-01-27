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
  getShareBaseUrlConfig,
  updateShareBaseUrlConfig,
  getAgentPaths,
  checkAgentStatus,
  checkMyAgentStatus,
  resetAgentStatus,
  updateUserStorageLimit,
} = require('../controllers/user.controller');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validation.middleware');
const {
  toggleSignupSchema,
  updateOnlyOfficeConfigSchema,
  updateAgentConfigSchema,
  updateShareBaseUrlConfigSchema,
  updateUserStorageLimitSchema,
  getCustomDriveSettingsSchema,
  updateCustomDriveSettingsSchema,
} = require('../utils/validationSchemas');

const router = express.Router();

router.use(auth);
router.use(apiRateLimiter);

router.get('/storage', storageUsage);
router.get('/signup-status', getSignupStatus);
router.post('/signup-toggle', toggleSignupSchema, validate, toggleSignup);
router.get('/all', listUsers);
router.get('/custom-drive/all', getAllUsersCustomDriveSettings);
router.get('/custom-drive', getCustomDriveSettingsSchema, validate, getCustomDriveSettings);
router.put('/custom-drive', updateCustomDriveSettingsSchema, validate, updateCustomDriveSettings);
router.get('/onlyoffice-configured', checkOnlyOfficeConfigured);
router.get('/onlyoffice-config', getOnlyOfficeConfig);
router.put('/onlyoffice-config', updateOnlyOfficeConfigSchema, validate, updateOnlyOfficeConfig);
router.get('/agent-config', getAgentConfig);
router.put('/agent-config', updateAgentConfigSchema, validate, updateAgentConfig);
router.get('/share-base-url-config', getShareBaseUrlConfig);
router.put('/share-base-url-config', updateShareBaseUrlConfigSchema, validate, updateShareBaseUrlConfig);
router.get('/agent-paths', getAgentPaths);
router.get('/agent-status', checkAgentStatus);
router.get('/my-agent-status', checkMyAgentStatus);
router.post('/agent-refresh', resetAgentStatus);
router.put('/storage-limit', updateUserStorageLimitSchema, validate, updateUserStorageLimit);

module.exports = router;
