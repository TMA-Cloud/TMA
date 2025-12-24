const {
  getUserStorageUsage,
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
  getUserCustomDriveSettings,
  updateUserCustomDriveSettings
} = require('../models/user.model');
const checkDiskSpace = require('check-disk-space').default;
const { sendError, sendSuccess } = require('../utils/response');
const pool = require('../config/db');
const path = require('path');
const { logger } = require('../config/logger');
const { logAuditEvent } = require('../services/auditLogger');

const STORAGE_LIMIT = Number(process.env.STORAGE_LIMIT || 100 * 1024 * 1024 * 1024);

async function storageUsage(req, res) {
  try {
    // Check if user has custom drive enabled
    const customDrive = await getUserCustomDriveSettings(req.userId);
    
    if (customDrive.enabled && customDrive.path) {
      // Get disk space information for the user's custom drive path
      const { size, free: diskFree } = await checkDiskSpace(customDrive.path);
      
      // Total is the actual disk size available on the custom drive path
      const total = size;
      
      // Free space is the actual free space on the disk
      const free = diskFree;
      
      // Used space is calculated from actual disk usage (total - free)
      // This reflects the real disk usage, not just database-tracked files
      const used = total - free;
      
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

async function getCustomDriveSettings(req, res) {
  try {
    // Allow users to view their own settings, but only admin can view others
    const { targetUserId } = req.query;
    const targetUserIdFinal = targetUserId || req.userId;
    
    // If requesting another user's settings, verify admin
    if (targetUserIdFinal !== req.userId) {
      const userIsFirst = await isFirstUser(req.userId);
      if (!userIsFirst) {
        await logAuditEvent('admin.custom_drive.get', {
          status: 'failure',
          resourceType: 'settings',
          metadata: { reason: 'unauthorized' }
        }, req);
        logger.warn({ userId: req.userId }, 'Unauthorized custom drive settings view attempt');
        return sendError(res, 403, 'Only the admin can view other users\' custom drive settings');
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

async function getAllUsersCustomDriveSettings(req, res) {
  try {
    // Only admin can view all users' custom drive settings
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent('admin.custom_drive.list', {
        status: 'failure',
        resourceType: 'settings',
        metadata: { reason: 'unauthorized' }
      }, req);
      logger.warn({ userId: req.userId }, 'Unauthorized all users custom drive settings view attempt');
      return sendError(res, 403, 'Only the admin can view all users\' custom drive settings');
    }

    const users = await getAllUsersBasic();
    const usersWithSettings = await Promise.all(
      users.map(async (user) => {
        try {
          const settings = await getUserCustomDriveSettings(user.id);
          return {
            id: user.id,
            email: user.email,
            name: user.name,
            createdAt: user.created_at,
            customDrive: {
              enabled: settings.enabled,
              path: settings.path
            }
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
              path: null
            }
          };
        }
      })
    );

    // Log admin action
    await logAuditEvent('admin.custom_drive.list', {
      status: 'success',
      resourceType: 'settings',
      metadata: { userCount: usersWithSettings.length }
    }, req);
    logger.info({ userId: req.userId, userCount: usersWithSettings.length }, 'All users custom drive settings viewed');

    sendSuccess(res, { users: usersWithSettings });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch all users custom drive settings');
    sendError(res, 500, 'Server error', err);
  }
}

async function updateCustomDriveSettings(req, res) {
  try {
    // Only admin (first user) can manage custom drive settings
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent('admin.custom_drive.update', {
        status: 'failure',
        resourceType: 'settings',
        metadata: { reason: 'unauthorized' }
      }, req);
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
    
    // If enabling, path is required
    if (enabled === true) {
      if (!path || typeof path !== 'string' || path.trim().length === 0) {
        return sendError(res, 400, 'path is required when enabling custom drive');
      }
    }
    
    // Get current settings to determine what to update
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
            return sendError(res, 400, 'Custom drive path cannot be empty or whitespace-only when custom drive is enabled');
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
    
    // Validate path if enabling
    if (finalEnabled && finalPath) {
      const fs = require('fs').promises;
      
      try {
        // Check if path exists and is accessible
        const stats = await fs.stat(finalPath);
        if (!stats.isDirectory()) {
          return sendError(res, 400, 'Custom drive path must be a directory');
        }
        // Path exists and is a directory - verify we have read/write access
        try {
          await fs.access(finalPath, fs.constants.R_OK | fs.constants.W_OK);
        } catch (accessError) {
          return sendError(res, 403, `No permission to access custom drive path: ${finalPath}. In Docker, ensure the volume is mounted with correct permissions (read/write access for the container user).`);
        }
      } catch (error) {
        if (error.code === 'ENOENT') {
          return sendError(res, 400, `Custom drive path does not exist: ${finalPath}. In Docker, ensure the path is mounted as a volume in docker-compose.yml.`);
        } else if (error.code === 'EACCES') {
          return sendError(res, 403, `No permission to access custom drive path: ${finalPath}. In Docker, ensure the volume is mounted with correct permissions (read/write access for the container user).`);
        } else {
          return sendError(res, 400, `Cannot access custom drive path: ${error.message}`);
        }
      }
    }
    
    // Acquire user operation lock to prevent race conditions with concurrent file operations
    // This ensures that if a user is uploading a file while settings are being changed,
    // the operations are serialized to prevent filesystem inconsistencies
    const { userOperationLock } = require('../utils/mutex');
    
    const updated = await userOperationLock(targetUserIdFinal, async () => {
      // Update settings
      let result;
      try {
        result = await updateUserCustomDriveSettings(targetUserIdFinal, finalEnabled, finalPath);
      } catch (err) {
        // Handle database unique constraint violation (one path = one owner)
        if (err.code === '23505' || err.constraint === 'idx_users_custom_drive_path_unique') {
          throw new Error('This path is already in use by another user. Each custom drive path can only be owned by one user.');
        }
        // Re-throw validation errors
        throw err;
      }
      
      // Invalidate cache for this user to ensure fresh data is used immediately after update
      const { invalidateCustomDriveCache } = require('../models/file.model');
      invalidateCustomDriveCache(targetUserIdFinal);
      
      // Restart watcher for target user if custom drive is enabled
      if (finalEnabled && finalPath) {
        const { restartUserWatcher } = require('../services/customDriveScanner');
        try {
          await restartUserWatcher(targetUserIdFinal, finalPath);
        } catch (error) {
          logger.error(`[Custom Drive] Failed to restart watcher for user ${targetUserIdFinal}:`, error.message);
          // Don't fail the request, just log the error
        }
      } else {
        // Stop watcher if disabled
        const { restartUserWatcher } = require('../services/customDriveScanner');
        try {
          await restartUserWatcher(targetUserIdFinal, null);
        } catch (error) {
          logger.error(`[Custom Drive] Failed to stop watcher for user ${targetUserIdFinal}:`, error.message);
        }
      }
      
      return result;
    });
    
    // Log settings update
    await logAuditEvent('admin.custom_drive.update', {
      status: 'success',
      resourceType: 'settings',
      metadata: {
        setting: 'custom_drive',
        targetUserId: targetUserIdFinal,
        enabled: finalEnabled,
        path: finalPath ? '***' : null // Don't log full path for security
      }
    }, req);
    logger.info({ adminUserId: req.userId, targetUserId: targetUserIdFinal, enabled: finalEnabled }, 'Custom drive settings updated by admin');
    
    sendSuccess(res, updated);
  } catch (err) {
    if (err.message === 'User not found') {
      return sendError(res, 404, 'User not found');
    }
    // Handle validation errors (path security, etc.)
    if (err.message.includes('path') || 
        err.message.includes('Path') || 
        err.message.includes('directory') ||
        err.message.includes('system') ||
        err.message.includes('already in use') ||
        err.message.includes('Cannot mount')) {
      return sendError(res, 400, err.message);
    }
    logger.error({ err }, 'Failed to update custom drive settings');
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = { 
  storageUsage, 
  getSignupStatus, 
  toggleSignup, 
  listUsers,
  getCustomDriveSettings,
  updateCustomDriveSettings,
  getAllUsersCustomDriveSettings
};
