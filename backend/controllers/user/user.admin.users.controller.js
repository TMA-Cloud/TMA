import { logger } from '../../config/logger.js';
import { getAllUsersBasic, isFirstUser, setUserStorageLimit } from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * List all users (admin only)
 */
async function listUsers(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.user.list',
        {
          status: 'failure',
          resourceType: 'user',
          metadata: { reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized user list attempt');
      return sendError(res, 403, 'Only the first user can view all users');
    }

    const usersBasic = await getAllUsersBasic();

    const users = usersBasic.map(user => ({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.created_at,
      mfaEnabled: user.mfa_enabled || false,
      storageLimit: user.storage_limit != null ? Number(user.storage_limit) : null,
      storageUsed: user.storage_used ?? 0,
      storageTotal: user.storage_total ?? null,
      parentUserId: user.parent_user_id || null,
      permissions: user.parent_user_id ? user.permissions || [] : null,
    }));

    // Log admin action
    await logAuditEvent(
      'admin.user.list',
      {
        status: 'success',
        resourceType: 'user',
        metadata: { userCount: users.length },
      },
      req
    );
    logger.info({ userId: req.userId, userCount: users.length }, 'Users list viewed');

    sendSuccess(res, { users });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch users list');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update user storage limit (admin only)
 */
async function updateUserStorageLimit(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.user.update',
        {
          status: 'failure',
          resourceType: 'user',
          metadata: { action: 'update_storage_limit', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized storage limit update attempt');
      return sendError(res, 403, 'Only the first user can set storage limits');
    }

    const { targetUserId, storageLimit } = req.body;

    await setUserStorageLimit(req.userId, targetUserId, storageLimit);

    await logAuditEvent(
      'admin.user.update',
      {
        status: 'success',
        resourceType: 'user',
        metadata: {
          action: 'update_storage_limit',
          targetUserId,
          storageLimit,
        },
      },
      req
    );
    logger.info({ userId: req.userId, targetUserId, storageLimit }, 'User storage limit updated');

    sendSuccess(res, { storageLimit });
  } catch (err) {
    if (err.message === 'Only the first user can set storage limits') {
      await logAuditEvent(
        'admin.user.update',
        {
          status: 'failure',
          resourceType: 'user',
          errorMessage: err.message,
          metadata: { action: 'update_storage_limit' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized storage limit update attempt');
      return sendError(res, 403, err.message);
    }
    // Validation errors from setUserStorageLimit (e.g. limit exceeds disk, invalid format) → 400 so frontend can show the message
    if (
      err.message?.startsWith('Storage limit') ||
      err.message?.startsWith('Sub-users share') ||
      err.message === 'Invalid targetUserId format' ||
      err.message === 'User not found'
    ) {
      logger.warn({ err, userId: req.userId }, 'Storage limit update rejected');
      return sendError(res, 400, err.message);
    }
    logger.error({ err }, 'Failed to update user storage limit');
    sendError(res, 500, 'Server error', err);
  }
}

export { listUsers, updateUserStorageLimit };
