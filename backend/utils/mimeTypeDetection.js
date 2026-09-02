/**
 * MIME Type Detection Index
 *
 * Re-exports the MIME detection surface, split into focused modules. Import
 * paths and exported names are unchanged so consumers do not move:
 * - mimeTypeDetection/core.js       - magic-byte detection, declared-type validation, sniff stream
 * - mimeTypeDetection/onlyoffice.js - extension→MIME tables and OnlyOffice type validation
 */

export { detectMimeTypeFromContent, validateMimeType, createMimeSniffStream } from './mimeTypeDetection/core.js';
export { validateOnlyOfficeMimeType } from './mimeTypeDetection/onlyoffice.js';
