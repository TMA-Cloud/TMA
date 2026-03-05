const express = require('express');
const auth = require('../middleware/auth.middleware');
const {
  getSignupStatus,
  toggleSignup,
  listUsers,
  storageUsage,
  checkOnlyOfficeConfigured,
  getOnlyOfficeConfig,
  updateOnlyOfficeConfig,
  getShareBaseUrlConfig,
  updateShareBaseUrlConfig,
  getMaxUploadSizeConfig,
  updateMaxUploadSizeConfig,
  getHideFileExtensionsConfig,
  updateHideFileExtensionsConfig,
  updateUserStorageLimit,
  getElectronOnlyAccessConfig,
  updateElectronOnlyAccessConfig,
  getPasswordChangeConfig,
  updatePasswordChangeConfig,
} = require('../controllers/user.controller');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');
const { validate } = require('../middleware/validation.middleware');
const {
  toggleSignupSchema,
  updateOnlyOfficeConfigSchema,
  updateShareBaseUrlConfigSchema,
  updateMaxUploadSizeConfigSchema,
  updateHideFileExtensionsConfigSchema,
  updateUserStorageLimitSchema,
  updateElectronOnlyAccessConfigSchema,
  updatePasswordChangeConfigSchema,
} = require('../utils/validationSchemas');

const router = express.Router();

router.use(auth);
router.use(apiRateLimiter);

router.get('/signup-status', getSignupStatus);
router.post('/signup-toggle', toggleSignupSchema, validate, toggleSignup);
router.get('/all', listUsers);
router.get('/storage', storageUsage);
router.get('/onlyoffice-configured', checkOnlyOfficeConfigured);
router.get('/onlyoffice-config', getOnlyOfficeConfig);
router.put('/onlyoffice-config', updateOnlyOfficeConfigSchema, validate, updateOnlyOfficeConfig);
router.get('/share-base-url-config', getShareBaseUrlConfig);
router.put('/share-base-url-config', updateShareBaseUrlConfigSchema, validate, updateShareBaseUrlConfig);
router.get('/max-upload-size-config', getMaxUploadSizeConfig);
router.put('/max-upload-size-config', updateMaxUploadSizeConfigSchema, validate, updateMaxUploadSizeConfig);
router.get('/hide-file-extensions-config', getHideFileExtensionsConfig);
router.put(
  '/hide-file-extensions-config',
  updateHideFileExtensionsConfigSchema,
  validate,
  updateHideFileExtensionsConfig
);
router.get('/electron-only-access-config', getElectronOnlyAccessConfig);
router.put(
  '/electron-only-access-config',
  updateElectronOnlyAccessConfigSchema,
  validate,
  updateElectronOnlyAccessConfig
);
router.get('/password-change-config', getPasswordChangeConfig);
router.put('/password-change-config', updatePasswordChangeConfigSchema, validate, updatePasswordChangeConfig);
router.put('/storage-limit', updateUserStorageLimitSchema, validate, updateUserStorageLimit);

module.exports = router;
