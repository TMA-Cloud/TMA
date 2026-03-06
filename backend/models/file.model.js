/**
 * File Model Index
 *
 * This file re-exports all file models for backward compatibility.
 * The models have been split into smaller, more maintainable modules:
 * - file.utils.model.js - Utility functions (sorting, folder size, path building)
 * - file.crud.model.js - Basic CRUD operations
 * - file.operations.model.js - File operations (move, copy)
 * - file.metadata.model.js - Metadata operations (star, share)
 * - file.trash.model.js - Trash operations
 * - file.cleanup.model.js - Cleanup operations
 * - file.search.model.js - Search and stats
 * - file.info.model.js - File info query utilities
 */

export * from './file/file.crud.model.js';
export * from './file/file.operations.model.js';
export * from './file/file.metadata.model.js';
export * from './file/file.trash.model.js';
export * from './file/file.cleanup.model.js';
export * from './file/file.search.model.js';
export * from './file/file.info.model.js';
