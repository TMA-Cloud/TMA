/**
 * User Admin Controller Index
 *
 * Re-exports the admin handlers, split into focused modules by concern.
 * Import paths and exported names are unchanged so consumers (routes, the
 * controllers/user.controller.js barrel) do not move:
 * - user.admin.config.controller.js  - instance settings get/update (signup, onlyoffice, etc.)
 * - user.admin.users.controller.js   - user listing and storage-limit administration
 * - user.admin.clients.controller.js - desktop client heartbeat and active-client listing
 */

export {
  getPublicSignupStatus,
  getSignupStatus,
  toggleSignup,
  checkOnlyOfficeConfigured,
  getOnlyOfficeConfig,
  updateOnlyOfficeConfig,
  getShareBaseUrlConfig,
  updateShareBaseUrlConfig,
  getMaxUploadSizeConfig,
  updateMaxUploadSizeConfig,
  getHideFileExtensionsConfig,
  updateHideFileExtensionsConfig,
  getElectronOnlyAccessConfig,
  updateElectronOnlyAccessConfig,
  getPasswordChangeConfig,
  updatePasswordChangeConfig,
} from './user.admin.config.controller.js';
export { listUsers, updateUserStorageLimit } from './user.admin.users.controller.js';
export { clientHeartbeat, getActiveClients } from './user.admin.clients.controller.js';
