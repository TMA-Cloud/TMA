/**
 * User Model Index
 *
 * This file re-exports all user models for backward compatibility.
 * The models have been split into smaller, more maintainable modules:
 * - user.crud.model.js - Basic CRUD operations (createUser, getUserByEmail, getUserById, getUserByGoogleId, createUserWithGoogle, updateGoogleId)
 * - user.auth.model.js - Authentication/session operations (getUserTokenVersion, invalidateAllSessions)
 * - user.storage.model.js - Storage operations (getUserStorageUsage)
 * - user.admin.model.js - Admin operations (isFirstUser, getSignupEnabled, setSignupEnabled, getTotalUserCount, getAllUsersBasic, handleFirstUserSetup)
 * - user.customDrive.model.js - Custom drive operations (getUserCustomDriveSettings, updateUserCustomDriveSettings, getUsersWithCustomDrive)
 */

const crudModels = require('./user/user.crud.model');
const authModels = require('./user/user.auth.model');
const storageModels = require('./user/user.storage.model');
const adminModels = require('./user/user.admin.model');
const customDriveModels = require('./user/user.customDrive.model');

module.exports = {
  ...crudModels,
  ...authModels,
  ...storageModels,
  ...adminModels,
  ...customDriveModels,
};
