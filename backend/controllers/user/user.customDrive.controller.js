const {
  isFirstUser,
  getUserCustomDriveSettings,
  updateUserCustomDriveSettings,
  getAllUsersBasic,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');

/**
 * Get custom drive settings for a user
 */
async function getCustomDriveSettings(req, res) {
  try {
    // Allow users to view their own settings, but only admin can view others
    const { targetUserId } = req.query;
    const targetUserIdFinal = targetUserId || req.userId;

    // If requesting another user's settings, verify admin
    if (targetUserIdFinal !== req.userId) {
      const userIsFirst = await isFirstUser(req.userId);
      if (!userIsFirst) {
        await logAuditEvent(
          'admin.custom_drive.get',
          {
            status: 'failure',
            resourceType: 'settings',
            metadata: { reason: 'unauthorized' },
          },
          req
        );
        logger.warn({ userId: req.userId }, 'Unauthorized custom drive settings view attempt');
        return sendError(res, 403, "Only the admin can view other users' custom drive settings");
      }
    }

    const settings = await getUserCustomDriveSettings(targetUserIdFinal);
    sendSuccess(res, settings);
  } catch (err) {
    if (err.message === 'User not found') {
      return sendError(res, 404, 'User not found');
    }
    logger.error({ err }, 'Failed to get custom drive settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get all users' custom drive settings (admin only)
 */
async function getAllUsersCustomDriveSettings(req, res) {
  try {
    // Only admin can view all users' custom drive settings
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.custom_drive.list',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized all users custom drive settings view attempt');
      return sendError(res, 403, "Only the admin can view all users' custom drive settings");
    }

    const users = await getAllUsersBasic();
    const usersWithSettings = await Promise.all(
      users.map(async user => {
        try {
          const settings = await getUserCustomDriveSettings(user.id);
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.created_at,
            customDrive: {
              enabled: settings.enabled,
              path: settings.path,
            },
          };
        } catch (err) {
          logger.error({ userId: user.id, err }, 'Failed to get custom drive settings for user');
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.created_at,
            customDrive: {
              enabled: false,
              path: null,
            },
          };
        }
      })
    );

    // Note: No audit logging for view operations - only log actual changes

    sendSuccess(res, { users: usersWithSettings });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch all users custom drive settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update custom drive settings (admin only)
 */
async function updateCustomDriveSettings(req, res) {
  try {
    // Only admin (first user) can manage custom drive settings
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.custom_drive.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized custom drive settings update attempt');
      return sendError(res, 403, 'Only the admin can manage custom drive settings');
    }

    const { enabled, path, targetUserId } = req.body;

    // Determine which user's settings to update (default to admin's own settings)
    const targetUserIdFinal = targetUserId || req.userId;

    // Validate enabled is boolean
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return sendError(res, 400, 'enabled must be a boolean');
    }

    // Basic validation before acquiring lock
    // If enabling, path is required
    if (enabled === true) {
      if (!path || typeof path !== 'string' || path.trim().length === 0) {
        return sendError(res, 400, 'path is required when enabling custom drive');
      }
    }

    // Acquire user operation lock to prevent race conditions with concurrent updates
    // This ensures that concurrent updates to the same user are serialized
    const { userOperationLock } = require('../../utils/mutex');

    const updated = await userOperationLock(targetUserIdFinal, async () => {
      // Get current settings INSIDE the lock to prevent TOCTOU race conditions
      // This ensures we always work with the latest state
      const currentSettings = await getUserCustomDriveSettings(targetUserIdFinal);
      const newEnabled = enabled !== undefined ? enabled : currentSettings.enabled;

      // Process path: validate whitespace-only paths before processing
      let processedPath;
      if (path !== undefined) {
        // Path was explicitly provided in request
        if (path === null) {
          processedPath = null;
        } else if (typeof path === 'string') {
          const trimmed = path.trim();
          if (trimmed === '') {
            // Whitespace-only path provided - reject if not explicitly disabling
            // If enabled is not explicitly set to false, this is an invalid update
            if (enabled !== false && newEnabled) {
              throw new Error('Custom drive path cannot be empty or whitespace-only when custom drive is enabled');
            }
            // If explicitly disabling, whitespace path is acceptable (will be cleared)
            processedPath = null;
          } else {
            processedPath = trimmed;
          }
        } else {
          processedPath = null;
        }
      } else {
        // Path not provided - use current setting
        processedPath = currentSettings.path;
      }

      // If disabling, clear path
      const finalEnabled = newEnabled;
      const finalPath = finalEnabled ? processedPath : null;

      // Validate path if enabling (inside lock to prevent race conditions)
      if (finalEnabled && finalPath) {
        const fs = require('fs').promises;

        try {
          // Check if path exists and is accessible
          const stats = await fs.stat(finalPath);
          if (!stats.isDirectory()) {
            throw new Error('Custom drive path must be a directory');
          }
          // Path exists and is a directory - verify we have read/write access
          try {
            await fs.access(finalPath, fs.constants.R_OK | fs.constants.W_OK);
          } catch (_accessError) {
            throw new Error(
              `No permission to access custom drive path: ${finalPath}. In Docker, ensure the volume is mounted with correct permissions (read/write access for the container user).`
            );
          }
        } catch (error) {
          if (error.code === 'ENOENT') {
            throw new Error(
              `Custom drive path does not exist: ${finalPath}. In Docker, ensure the path is mounted as a volume in docker-compose.yml.`
            );
          } else if (error.code === 'EACCES') {
            throw new Error(
              `No permission to access custom drive path: ${finalPath}. In Docker, ensure the volume is mounted with correct permissions (read/write access for the container user).`
            );
          } else if (!error.code) {
            // Re-throw our custom error messages (custom errors don't have a code property)
            throw error;
          } else {
            // Unexpected filesystem error with a code property
            throw new Error(`Cannot access custom drive path: ${error.message || error.code}`);
          }
        }
      }

      // Update settings
      let result;
      try {
        result = await updateUserCustomDriveSettings(targetUserIdFinal, finalEnabled, finalPath);
      } catch (err) {
        // Handle database unique constraint violation (one path = one owner)
        if (err.code === '23505' || err.constraint === 'idx_users_custom_drive_path_unique') {
          throw new Error(
            'This path is already in use by another user. Each custom drive path can only be owned by one user.'
          );
        }
        // Re-throw validation errors (including path validation errors)
        throw err;
      }

      // Invalidate cache for this user to ensure fresh data is used immediately after update
      const { invalidateCustomDriveCache } = require('../../models/file.model');
      await invalidateCustomDriveCache(targetUserIdFinal);

      // Restart watcher for target user if custom drive is enabled
      if (finalEnabled && finalPath) {
        const { restartUserWatcher } = require('../../services/customDriveScanner');
        try {
          await restartUserWatcher(targetUserIdFinal, finalPath);
        } catch (error) {
          logger.error(`[Custom Drive] Failed to restart watcher for user ${targetUserIdFinal}:`, error.message);
          // Don't fail the request, just log the error
        }
      } else {
        // Stop watcher if disabled
        const { restartUserWatcher } = require('../../services/customDriveScanner');
        try {
          await restartUserWatcher(targetUserIdFinal, null);
        } catch (error) {
          logger.error(`[Custom Drive] Failed to stop watcher for user ${targetUserIdFinal}:`, error.message);
        }
      }

      // Return both the result and the final values for logging outside the lock
      return { result, finalEnabled, finalPath };
    });

    // Log settings update (using values returned from the lock)
    await logAuditEvent(
      'admin.custom_drive.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          setting: 'custom_drive',
          targetUserId: targetUserIdFinal,
          enabled: updated.finalEnabled,
          path: updated.finalPath ? '***' : null, // Don't log full path for security
        },
      },
      req
    );
    logger.info(
      { adminUserId: req.userId, targetUserId: targetUserIdFinal, enabled: updated.finalEnabled },
      'Custom drive settings updated by admin'
    );

    sendSuccess(res, updated.result);
  } catch (err) {
    if (err.message === 'User not found') {
      return sendError(res, 404, 'User not found');
    }
    // Handle validation errors (path security, etc.)
    if (
      err.message &&
      (err.message.includes('path') ||
        err.message.includes('Path') ||
        err.message.includes('directory') ||
        err.message.includes('system') ||
        err.message.includes('already in use') ||
        err.message.includes('Cannot mount') ||
        err.message.includes('permission') ||
        err.message.includes('does not exist'))
    ) {
      return sendError(res, 400, err.message);
    }
    logger.error({ err }, 'Failed to update custom drive settings');
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  getCustomDriveSettings,
  getAllUsersCustomDriveSettings,
  updateCustomDriveSettings,
};
