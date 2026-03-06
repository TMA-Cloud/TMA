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

export * from './file/file.crud.controller.js';
export * from './file/file.operations.controller.js';
export * from './file/file.metadata.controller.js';
export * from './file/file.trash.controller.js';
export * from './file/file.search.controller.js';
