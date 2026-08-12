/**
 * Sub-user management.
 *
 * Every route here is guarded by `requireAccountOwner`, so `req.userId` is
 * always a top-level account and is safe to use as the parent. A sub-user that
 * reaches these handlers has already been rejected with 403, which is what
 * makes "a sub-user cannot create sub-users" hold at the API surface as well
 * as in the schema.
 */

import bcrypt from 'bcryptjs';

import { logger } from '../../config/logger.js';
import {
  createSubUser,
  deleteSubUser,
  getSubUser,
  getUserByEmail,
  listSubUsers,
  updateSubUserPermissions,
} from '../../models/user.model.js';
import { deleteAllUserSessions } from '../../models/session.model.js';
import { deleteAllHeartbeatsForUser } from '../../models/clientHeartbeat.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { PERMISSION_CATALOG, normalizePermissions } from '../../utils/permissions.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/** Shape a sub-user row for the API. Never leaks the password hash. */
function toSubUserResponse(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    permissions: normalizePermissions(row.permissions),
    createdAt: row.created_at,
    mfaEnabled: row.mfa_enabled || false,
  };
}

/**
 * List the current owner's sub-users.
 */
async function _listSubUsers(req, res) {
  try {
    const subUsers = await listSubUsers(req.userId);
    // The catalog rides along so the UI renders exactly the capabilities the
    // server enforces, rather than a hard-coded copy that can drift.
    sendSuccess(res, {
      subUsers: subUsers.map(toSubUserResponse),
      availablePermissions: PERMISSION_CATALOG,
    });
  } catch (err) {
    logger.error({ err, ownerId: req.userId }, 'Failed to list sub-users');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Create a sub-user under the current owner.
 */
async function _createSubUser(req, res) {
  try {
    const { email, password, name, permissions } = req.body;

    // Emails are unique across the whole users table, so a sub-user cannot
    // reuse an address that already belongs to any other account.
    const existing = await getUserByEmail(email);
    if (existing) {
      await logAuditEvent(
        'account.sub_user.create',
        {
          status: 'failure',
          resourceType: 'user',
          metadata: { email, reason: 'email_already_in_use' },
        },
        req
      );
      return sendError(res, 409, 'Email already in use');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const subUser = await createSubUser({
      ownerId: req.userId,
      email,
      hashedPassword,
      name,
      permissions,
    });

    await logAuditEvent(
      'account.sub_user.create',
      {
        status: 'success',
        resourceType: 'user',
        resourceId: subUser.id,
        metadata: { email, permissions: subUser.permissions },
      },
      req
    );
    logger.info({ ownerId: req.userId, subUserId: subUser.id, permissions: subUser.permissions }, 'Sub-user created');

    sendSuccess(res, { subUser: toSubUserResponse(subUser) }, 201);
  } catch (err) {
    if (err.message === 'Sub-users cannot create sub-users') {
      return sendError(res, 403, err.message);
    }
    if (err.message === 'Owner account not found') {
      return sendError(res, 404, err.message);
    }
    if (err.message === 'Invalid sub-user permissions' || err.message === 'Sub-user name is required') {
      return sendError(res, 400, err.message);
    }
    // Unique violation on email, in case of a race with another request.
    if (err.code === '23505') {
      return sendError(res, 409, 'Email already in use');
    }
    // The database's own nesting guard fired — the checks above should have
    // caught this first, so treat it as the same 403 rather than a 500.
    if (err.code === '23514' && /sub-user/i.test(err.message || '')) {
      return sendError(res, 403, 'Sub-users cannot create sub-users');
    }
    logger.error({ err, ownerId: req.userId }, 'Failed to create sub-user');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Replace a sub-user's granted permissions.
 */
async function _updateSubUser(req, res) {
  try {
    const { id } = req.params;
    const { permissions } = req.body;

    const updated = await updateSubUserPermissions(req.userId, id, permissions);
    if (!updated) {
      return sendError(res, 404, 'Sub-user not found');
    }

    await logAuditEvent(
      'account.sub_user.update',
      {
        status: 'success',
        resourceType: 'user',
        resourceId: id,
        metadata: { permissions: updated.permissions },
      },
      req
    );
    logger.info(
      { ownerId: req.userId, subUserId: id, permissions: updated.permissions },
      'Sub-user permissions updated'
    );

    sendSuccess(res, { subUser: toSubUserResponse(updated) });
  } catch (err) {
    logger.error({ err, ownerId: req.userId }, 'Failed to update sub-user');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Delete a sub-user. The account's files are untouched — they were always
 * stored under the owner's ID — only the login goes away.
 */
async function _deleteSubUser(req, res) {
  try {
    const { id } = req.params;

    const existing = await getSubUser(req.userId, id);
    if (!existing) {
      return sendError(res, 404, 'Sub-user not found');
    }

    // Drop sessions before the row so the cached "session is valid" answer is
    // cleared too; otherwise a deleted sub-user could keep working until the
    // session cache expired.
    await deleteAllUserSessions(id);
    await deleteAllHeartbeatsForUser(id);
    await deleteSubUser(req.userId, id);

    await logAuditEvent(
      'account.sub_user.delete',
      {
        status: 'success',
        resourceType: 'user',
        resourceId: id,
        metadata: { email: existing.email, permissions: existing.permissions },
      },
      req
    );
    logger.info({ ownerId: req.userId, subUserId: id }, 'Sub-user deleted');

    sendSuccess(res, { message: 'Sub-user removed' });
  } catch (err) {
    logger.error({ err, ownerId: req.userId }, 'Failed to delete sub-user');
    sendError(res, 500, 'Server error', err);
  }
}

export {
  _listSubUsers as listSubUsers,
  _createSubUser as createSubUser,
  _updateSubUser as updateSubUser,
  _deleteSubUser as deleteSubUser,
};
