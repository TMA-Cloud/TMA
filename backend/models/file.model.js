/**
 * File Model Index
 *
 * This file re-exports all file models for backward compatibility.
 * The models have been split into smaller, more maintainable modules:
 * - file.cache.model.js - Cache-related functions
 * - file.utils.model.js - Utility functions (sorting, folder size, path building)
 * - file.crud.model.js - Basic CRUD operations
 * - file.operations.model.js - File operations (move, copy)
 * - file.metadata.model.js - Metadata operations (star, share)
 * - file.trash.model.js - Trash operations
 * - file.cleanup.model.js - Cleanup operations
 * - file.search.model.js - Search and stats
 */

const cacheModels = require('./file/file.cache.model');
const crudModels = require('./file/file.crud.model');
const operationsModels = require('./file/file.operations.model');
const metadataModels = require('./file/file.metadata.model');
const trashModels = require('./file/file.trash.model');
const cleanupModels = require('./file/file.cleanup.model');
const searchModels = require('./file/file.search.model');

module.exports = {
  ...cacheModels,
  ...crudModels,
  ...operationsModels,
  ...metadataModels,
  ...trashModels,
  ...cleanupModels,
  ...searchModels,
};
