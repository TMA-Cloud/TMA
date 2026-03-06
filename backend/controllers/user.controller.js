/**
 * User Controller Index
 *
 * This file re-exports all user controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - user.storage.controller.js - Storage operations
 * - user.admin.controller.js - Admin operations (signup, user management)
 */

export * from './user/user.storage.controller.js';
export * from './user/user.admin.controller.js';
