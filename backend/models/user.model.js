/**
 * User Model Index
 *
 * This file re-exports all user models for backward compatibility.
 * The models have been split into smaller, more maintainable modules:
 * - user.crud.model.js - Basic CRUD operations (createUser, getUserByEmail, getUserById, getUserByGoogleId, createUserWithGoogle, updateGoogleId)
 * - user.auth.model.js - Authentication/session operations (getUserTokenVersion, invalidateAllSessions)
 * - user.storage.model.js - Storage operations (getUserStorageUsage)
 * - user.admin.model.js - Admin operations (isFirstUser, getSignupEnabled, setSignupEnabled, getTotalUserCount, getAllUsersBasic, handleFirstUserSetup)
 * - user.mfa.model.js - MFA operations (getMfaStatus, enableMfa, disableMfa, getMfaSecret)
 */

export * from './user/user.crud.model.js';
export * from './user/user.auth.model.js';
export * from './user/user.storage.model.js';
export * from './user/user.admin.model.js';
export * from './user/user.mfa.model.js';
