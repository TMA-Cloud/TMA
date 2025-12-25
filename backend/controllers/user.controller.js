/**
 * User Controller Index
 *
 * This file re-exports all user controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - user.storage.controller.js - Storage operations
 * - user.admin.controller.js - Admin operations (signup, user management)
 * - user.customDrive.controller.js - Custom drive operations
 */

const storageControllers = require('./user/user.storage.controller');
const adminControllers = require('./user/user.admin.controller');
const customDriveControllers = require('./user/user.customDrive.controller');

module.exports = {
  ...storageControllers,
  ...adminControllers,
  ...customDriveControllers,
};
