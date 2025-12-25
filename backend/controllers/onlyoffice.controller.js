/**
 * OnlyOffice Controller Index
 *
 * This file re-exports all OnlyOffice controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - onlyoffice.utils.js - Utility functions and shared constants
 * - onlyoffice.config.controller.js - Configuration endpoint
 * - onlyoffice.file.controller.js - File serving endpoint
 * - onlyoffice.viewer.controller.js - Viewer page generation
 * - onlyoffice.callback.controller.js - Callback handling
 */

const configControllers = require('./onlyoffice/onlyoffice.config.controller');
const fileControllers = require('./onlyoffice/onlyoffice.file.controller');
const viewerControllers = require('./onlyoffice/onlyoffice.viewer.controller');
const callbackControllers = require('./onlyoffice/onlyoffice.callback.controller');

module.exports = {
  ...configControllers,
  ...fileControllers,
  ...viewerControllers,
  ...callbackControllers,
};
