/**
 * Audit Logger Index
 *
 * Re-exports the audit logging surface, split into focused modules. Import
 * paths and exported names are unchanged so consumers do not move:
 * - auditLogger/queue.js  - pg-boss lifecycle, redaction, and the core logAuditEvent
 * - auditLogger/events.js - convenience wrappers for common domain events
 */

export { initializeAuditQueue, shutdownAuditQueue, getBoss, logAuditEvent } from './auditLogger/queue.js';
export {
  fileUploaded,
  fileDownloaded,
  fileDeleted,
  loginSuccess,
  loginFailure,
  userSignup,
  shareCreated,
  shareAccessed,
  filesUploadedBulk,
} from './auditLogger/events.js';
