const {
  getUserStorageUsage,
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic
} = require('../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendError, sendSuccess } = require('../utils/response');
const { CUSTOM_DRIVE_ENABLED, CUSTOM_DRIVE_PATH } = require('../config/paths');
const pool = require('../config/db');
const path = require('path');
const { logger } = require('../config/logger');
const { logAuditEvent } = require('../services/auditLogger');

const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 100 * 1024 * 1024 * 1024);

/**
 * Calculate storage usage from custom drive path
 * Returns used space from files in the custom drive directory
 */
async function getCustomDriveStorageUsage(userId) {
  if (!CUSTOM_DRIVE_ENABLED || !CUSTOM_DRIVE_PATH) {
    return null;
  }

  const normalizedPath = path.resolve(CUSTOM_DRIVE_PATH).toLowerCase();

  // Escape LIKE wildcards (%, _) in the path to prevent unintended matches
  const escapedPath = normalizedPath.replace(/[%_]/g, '\\$&');

  // Calculate used space from files in the custom drive path
  const res = await pool.query(
    `SELECT COALESCE(SUM(size), 0) AS used
     FROM files
     WHERE user_id = $1
       AND type = 'file'
       AND deleted_at IS NULL
       AND path IS NOT NULL
       AND LOWER(path) LIKE $2 || '%' ESCAPE '\\'`,
    [userId, escapedPath]
  );

  return Number(res.rows[0].used) || 0;
}

async function storageUsage(req, res) {
  try {
    // If custom drive is enabled, use custom drive storage calculation
    if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
      const used = await getCustomDriveStorageUsage(req.userId);
      
      // Get disk space information for the custom drive path
      const { size, free: diskFree } = await checkDiskSpace(CUSTOM_DRIVE_PATH);
      
      // Total is the actual disk size available on the custom drive path
      const total = size;
      
      // Free space is the actual free space on the disk
      const free = diskFree;
      
      sendSuccess(res, { used, total, free });
    } else {
      // Original logic for regular uploads
      const used = await getUserStorageUsage(req.userId);
      const { size, free: diskFree } = await checkDiskSpace(process.env.STORAGE_PATH || __dirname);
      const total = Math.min(size, STORAGE_LIMIT);
      const remainingLimit = Math.max(total - used, 0);
      const free = Math.min(diskFree, remainingLimit);
      sendSuccess(res, { used, total, free });
    }
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function getSignupStatus(req, res) {
  try {
    const signupEnabled = await getSignupEnabled();
    const userIsFirst = await isFirstUser(req.userId);
    let totalUsers;

    if (userIsFirst) {
      totalUsers = await getTotalUserCount();
    }

    sendSuccess(res, {
      signupEnabled,
      canToggle: userIsFirst,
      totalUsers,
      additionalUsers: typeof totalUsers === 'number' ? Math.max(totalUsers - 1, 0) : undefined
    });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function toggleSignup(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent('admin.settings.update', {
        status: 'failure',
        resourceType: 'settings',
        metadata: { action: 'toggle_signup', reason: 'unauthorized' }
      }, req);
      logger.warn({ userId: req.userId }, 'Unauthorized signup toggle attempt');
      return sendError(res, 403, 'Only the first user can toggle signup');
    }

    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return sendError(res, 400, 'enabled must be a boolean');
    }

    // setSignupEnabled will do additional security checks internally
    await setSignupEnabled(enabled, req.userId);

    // Log admin action
    await logAuditEvent('admin.settings.update', {
      status: 'success',
      resourceType: 'settings',
      metadata: { setting: 'signup_enabled', newValue: enabled }
    }, req);
    logger.info({ userId: req.userId, signupEnabled: enabled }, 'Signup setting toggled');

    sendSuccess(res, { signupEnabled: enabled });
  } catch (err) {
    if (err.message === 'Only the first user can toggle signup') {
      await logAuditEvent('admin.settings.update', {
        status: 'failure',
        resourceType: 'settings',
        errorMessage: err.message,
        metadata: { action: 'toggle_signup' }
      }, req);
      logger.warn({ userId: req.userId }, 'Unauthorized signup toggle attempt');
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to toggle signup');
    sendError(res, 500, 'Server error', err);
  }
}

async function listUsers(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent('admin.user.list', {
        status: 'failure',
        resourceType: 'user',
        metadata: { reason: 'unauthorized' }
      }, req);
      logger.warn({ userId: req.userId }, 'Unauthorized user list attempt');
      return sendError(res, 403, 'Only the first user can view all users');
    }

    const users = (await getAllUsersBasic()).map((user) => ({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.created_at
    }));

    // Log admin action
    await logAuditEvent('admin.user.list', {
      status: 'success',
      resourceType: 'user',
      metadata: { userCount: users.length }
    }, req);
    logger.info({ userId: req.userId, userCount: users.length }, 'Users list viewed');

    sendSuccess(res, { users });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch users list');
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = { storageUsage, getSignupStatus, toggleSignup, listUsers };
