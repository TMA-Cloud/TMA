/**
 * File Controller Index
 *
 * This file re-exports all file controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - file.crud.controller.js - Basic CRUD operations
 * - file.operations.controller.js - File operations (move, copy)
 * - file.metadata.controller.js - Metadata operations (star, share)
 * - file.trash.controller.js - Trash operations
 * - file.search.controller.js - Search and stats
 */

const crudControllers = require('./file/file.crud.controller');
const operationsControllers = require('./file/file.operations.controller');
const metadataControllers = require('./file/file.metadata.controller');
const trashControllers = require('./file/file.trash.controller');
const searchControllers = require('./file/file.search.controller');

module.exports = {
  ...crudControllers,
  ...operationsControllers,
  ...metadataControllers,
  ...trashControllers,
  ...searchControllers,
};
