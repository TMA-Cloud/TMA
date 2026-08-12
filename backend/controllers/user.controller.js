/**
 * User Controller Index
 *
 * This file re-exports all user controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - user.storage.controller.js - Storage operations
 * - user.admin.controller.js - Admin operations (signup, user management)
 * - user.orphans.controller.js - Orphan review and admin-driven cleanup
 * - user.subusers.controller.js - Sub-user management for account owners
 */

export * from './user/user.storage.controller.js';
export * from './user/user.admin.controller.js';
export * from './user/user.orphans.controller.js';
export * from './user/user.subusers.controller.js';
