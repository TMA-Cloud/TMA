/**
 * Convenience wrappers around logAuditEvent for common domain events. Keeping
 * these separate from the queue lifecycle keeps each call site to a single,
 * well-named function.
 */

import { logAuditEvent } from './queue.js';

/**
 * Log a file upload event
 */
async function fileUploaded(fileId, fileName, fileSize, req) {
  return logAuditEvent(
    'file.upload',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileName, fileSize },
    },
    req
  );
}

/**
 * Log a bulk file upload event (e.g. folder upload with many files).
 * Aggregates individual uploads into a single audit row.
 */
async function filesUploadedBulk(files, req, extraMetadata = {}) {
  const fileIds = Array.isArray(files) ? files.map(f => f.id).filter(Boolean) : [];
  const fileCount = fileIds.length;

  return logAuditEvent(
    'file.upload.bulk',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileIds[0] || null,
      metadata: {
        fileCount,
        fileIds,
        ...extraMetadata,
      },
    },
    req
  );
}

/**
 * Log a file download event
 */
async function fileDownloaded(fileId, fileName, req) {
  return logAuditEvent(
    'file.download',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileName },
    },
    req
  );
}

/**
 * Log a file delete event
 */
async function fileDeleted(fileId, fileName, permanent, req) {
  return logAuditEvent(
    permanent ? 'file.delete.permanent' : 'file.delete',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileName, permanent },
    },
    req
  );
}

/**
 * Log a successful login. Identity is passed in (not read from CLS) because
 * login runs before the auth middleware, else the row would get a NULL user_id.
 * @param {string} userId - Authenticated user ID
 * @param {string} email - Email used to log in
 * @param {Object} req - Express request
 * @param {Object} [account] - Account context ({ ownerId, role }) when known
 */
async function loginSuccess(userId, email, req, account = null) {
  return logAuditEvent(
    'auth.login',
    {
      status: 'success',
      resourceType: 'auth',
      actorUserId: userId,
      accountOwnerId: account?.ownerId || userId,
      actorRole: account?.isSubUser ? 'sub_user' : 'owner',
      metadata: { email, method: 'password' },
    },
    req
  );
}

/**
 * Log a failed login attempt
 */
async function loginFailure(email, reason, req) {
  return logAuditEvent(
    'auth.login.failure',
    {
      status: 'failure',
      resourceType: 'auth',
      metadata: { email, reason },
    },
    req
  );
}

/**
 * Log a user signup event
 */
async function userSignup(userId, email, method, req) {
  return logAuditEvent(
    'auth.signup',
    {
      status: 'success',
      resourceType: 'user',
      resourceId: userId,
      actorUserId: userId,
      accountOwnerId: userId,
      actorRole: 'owner',
      metadata: { email, method },
    },
    req
  );
}

/**
 * Log a share link creation
 */
async function shareCreated(shareId, fileIds, req) {
  return logAuditEvent(
    'share.create',
    {
      status: 'success',
      resourceType: 'share',
      resourceId: shareId,
      metadata: { fileCount: fileIds.length },
    },
    req
  );
}

/**
 * Log a share link access (may be anonymous)
 */
async function shareAccessed(shareId, req) {
  return logAuditEvent(
    'share.access',
    {
      status: 'success',
      resourceType: 'share',
      resourceId: shareId,
    },
    req
  );
}

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
};
