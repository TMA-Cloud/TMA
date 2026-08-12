/**
 * Account capability guards.
 *
 * The auth middleware resolves `req.permissions` and `req.isSubUser` for every
 * authenticated request. These guards turn that into an authorisation decision:
 *
 * - `requirePermission(key)` blocks a sub-user that was not granted a specific
 *   capability. Owners always pass — they hold every capability over their own
 *   account by definition.
 * - `requireAccountOwner` restricts an endpoint to top-level accounts, which is
 *   what stops a sub-user from managing sub-users of its own.
 */

import { logger } from '../config/logger.js';
import { logAuditEvent } from '../services/auditLogger.js';
import { PERMISSION_CATALOG, hasPermission } from '../utils/permissions.js';
import { sendError } from '../utils/response.js';

/** Human-readable label for a permission key, for error messages. */
function permissionLabel(permission) {
  return PERMISSION_CATALOG.find(p => p.key === permission)?.label || permission;
}

/**
 * Build a guard that requires a single capability.
 * @param {string} permission - One of the keys in utils/permissions.js
 * @returns {import('express').RequestHandler}
 */
function requirePermission(permission) {
  return async function permissionGuard(req, res, next) {
    if (hasPermission(req, permission)) {
      return next();
    }

    logger.warn(
      {
        userId: req.userId,
        ownerId: req.ownerId,
        permission,
        granted: req.permissions,
        method: req.method,
        path: req.path,
      },
      'Sub-user attempted an action without the required permission'
    );
    await logAuditEvent(
      'account.permission_denied',
      {
        status: 'failure',
        resourceType: 'account',
        metadata: { permission, method: req.method, path: req.path },
      },
      req
    );

    return sendError(
      res,
      403,
      `You do not have permission to do that. Ask the account owner to enable "${permissionLabel(permission)}".`
    );
  };
}

/**
 * Restrict a route to top-level account owners.
 */
async function requireAccountOwner(req, res, next) {
  if (!req.isSubUser) {
    return next();
  }

  logger.warn(
    { userId: req.userId, ownerId: req.ownerId, method: req.method, path: req.path },
    'Sub-user attempted an owner-only operation'
  );
  await logAuditEvent(
    'account.owner_action_denied',
    {
      status: 'failure',
      resourceType: 'account',
      metadata: { method: req.method, path: req.path, reason: 'sub_user' },
    },
    req
  );

  return sendError(res, 403, 'Only the account owner can perform this action.');
}

export { requirePermission, requireAccountOwner };
