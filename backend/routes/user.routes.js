import express from 'express';

import {
  checkOnlyOfficeConfigured,
  clientHeartbeat,
  createSubUser,
  deleteOrphans,
  deleteSubUser,
  getActiveClients,
  getElectronOnlyAccessConfig,
  getHideFileExtensionsConfig,
  getMaxUploadSizeConfig,
  getKnownProxiesConfig,
  getOnlyOfficeConfig,
  getOrphans,
  getPasswordChangeConfig,
  getShareBaseUrlConfig,
  getSignupStatus,
  listSubUsers,
  listUsers,
  storageUsage,
  toggleSignup,
  updateElectronOnlyAccessConfig,
  updateHideFileExtensionsConfig,
  updateMaxUploadSizeConfig,
  updateKnownProxiesConfig,
  updateOnlyOfficeConfig,
  updatePasswordChangeConfig,
  updateShareBaseUrlConfig,
  updateSubUser,
  updateUserStorageLimit,
} from '../controllers/user.controller.js';
import auth from '../middleware/auth.middleware.js';
import { requireAccountOwner } from '../middleware/accountRole.middleware.js';
import { apiRateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import {
  createSubUserSchema,
  deleteOrphansSchema,
  scanOrphansSchema,
  subUserIdParamSchema,
  toggleSignupSchema,
  updateElectronOnlyAccessConfigSchema,
  updateHideFileExtensionsConfigSchema,
  updateMaxUploadSizeConfigSchema,
  updateKnownProxiesConfigSchema,
  updateOnlyOfficeConfigSchema,
  updatePasswordChangeConfigSchema,
  updateShareBaseUrlConfigSchema,
  updateSubUserSchema,
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
router.get('/known-proxies-config', getKnownProxiesConfig);
router.put('/known-proxies-config', updateKnownProxiesConfigSchema, validate, updateKnownProxiesConfig);
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
router.get('/orphans', scanOrphansSchema, validate, getOrphans);
router.post('/orphans/delete', deleteOrphansSchema, validate, deleteOrphans);

// Sub-users. `requireAccountOwner` is what enforces that a sub-user cannot
// create, promote or remove sub-users of its own.
router.get('/sub-users', requireAccountOwner, listSubUsers);
router.post('/sub-users', requireAccountOwner, createSubUserSchema, validate, createSubUser);
router.put('/sub-users/:id', requireAccountOwner, updateSubUserSchema, validate, updateSubUser);
router.delete('/sub-users/:id', requireAccountOwner, subUserIdParamSchema, validate, deleteSubUser);

export default router;
