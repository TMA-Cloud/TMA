/**
 * Share Controller Index
 *
 * This file re-exports all share controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - share.utils.js - Utility functions (HTML escaping)
 * - share.access.controller.js - Shared content access (handleShared)
 * - share.download.controller.js - Download operations (downloadFolderZip, downloadSharedItem)
 */

const accessControllers = require('./share/share.access.controller');
const downloadControllers = require('./share/share.download.controller');

module.exports = {
  ...accessControllers,
  ...downloadControllers,
};
