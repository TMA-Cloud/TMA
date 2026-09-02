/**
 * User Admin Model Index
 *
 * Re-exports the admin/settings model functions, split into focused modules.
 * Import paths and exported names are unchanged so consumers (the
 * models/user.model.js barrel and any deep importers) do not move:
 * - user.admin.helpers.model.js  - first-user verification (shared)
 * - user.admin.settings.model.js - app_settings get/set (signup, onlyoffice, etc.)
 * - user.admin.users.model.js    - user listing, counts, and storage-limit administration
 */

export { isFirstUser } from './user.admin.helpers.model.js';
export {
  getSignupEnabled,
  setSignupEnabled,
  getOnlyOfficeSettings,
  setOnlyOfficeSettings,
  getShareBaseUrlSettings,
  setShareBaseUrlSettings,
  getMaxUploadSizeSettings,
  setMaxUploadSizeSettings,
  getHideFileExtensionsSettings,
  setHideFileExtensionsSettings,
  getElectronOnlyAccessSettings,
  setElectronOnlyAccessSettings,
  getPasswordChangeSettings,
  setPasswordChangeSettings,
} from './user.admin.settings.model.js';
export {
  getTotalUserCount,
  getAllUsersBasic,
  handleFirstUserSetup,
  getUserStorageLimit,
  setUserStorageLimit,
} from './user.admin.users.model.js';
