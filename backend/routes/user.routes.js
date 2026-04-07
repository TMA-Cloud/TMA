import express from 'express';

import {
  checkOnlyOfficeConfigured,
  clientHeartbeat,
  getActiveClients,
  getElectronOnlyAccessConfig,
  getHideFileExtensionsConfig,
  getMaxUploadSizeConfig,
  getOnlyOfficeConfig,
  getPasswordChangeConfig,
  getShareBaseUrlConfig,
  getSignupStatus,
  listUsers,
  storageUsage,
  toggleSignup,
  updateElectronOnlyAccessConfig,
  updateHideFileExtensionsConfig,
  updateMaxUploadSizeConfig,
  updateOnlyOfficeConfig,
  updatePasswordChangeConfig,
  updateShareBaseUrlConfig,
  updateUserStorageLimit,
} from '../controllers/user.controller.js';
import auth from '../middleware/auth.middleware.js';
import { apiRateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import {
  toggleSignupSchema,
  updateElectronOnlyAccessConfigSchema,
  updateHideFileExtensionsConfigSchema,
  updateMaxUploadSizeConfigSchema,
  updateOnlyOfficeConfigSchema,
  updatePasswordChangeConfigSchema,
  updateShareBaseUrlConfigSchema,
  updateUserStorageLimitSchema,
} from '../utils/validationSchemas.js';

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
router.post('/client-heartbeat', clientHeartbeat);
router.get('/active-clients', getActiveClients);

export default router;
