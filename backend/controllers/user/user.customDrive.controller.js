const {
  isFirstUser,
  getUserCustomDriveSettings,
  updateUserCustomDriveSettings,
  getAllUsersBasic,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { checkAgentForUser } = require('../../utils/agentCheck');

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
              ignorePatterns: settings.ignorePatterns || [],
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
              ignorePatterns: [],
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

    const { enabled, path, targetUserId, ignorePatterns } = req.body;

    // Determine which user's settings to update (default to admin's own settings)
    const targetUserIdFinal = targetUserId || req.userId;

    // Validate enabled is boolean
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return sendError(res, 400, 'enabled must be a boolean');
    }

    // Validate ignorePatterns if provided
    if (ignorePatterns !== undefined) {
      if (!Array.isArray(ignorePatterns)) {
        return sendError(res, 400, 'ignorePatterns must be an array');
      }
      // Validate each pattern is a string
      for (const pattern of ignorePatterns) {
        if (typeof pattern !== 'string') {
          return sendError(res, 400, 'All ignore patterns must be strings');
        }
      }
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
      // IMPORTANT: Custom drive paths are validated via agent API, not direct filesystem access
      // This allows paths on the host to be validated even when the app runs in Docker
      if (finalEnabled && finalPath) {
        // Check if agent is configured (has URL) - if so, always use agent for validation
        // This ensures Docker setups always use agent, even when user doesn't have custom drive enabled yet
        const { getAgentSettings } = require('../../models/user.model');
        const agentSettings = await getAgentSettings();
        const agentConfigured = agentSettings && agentSettings.url;

        if (agentConfigured) {
          // Agent is configured - validate via agent API (required for Docker)
          const { checkAgentStatus } = require('../../utils/agentClient');
          const isOnline = await checkAgentStatus();
          if (!isOnline) {
            throw new Error('Agent is offline. Please ensure the agent is running and configured in Settings.');
          }

          try {
            const { agentStatPath } = require('../../utils/agentFileOperations');
            const { getAgentPaths } = require('../../utils/agentClient');

            // First, check if the path is in the agent's configured paths
            let agentPaths = [];
            try {
              agentPaths = await getAgentPaths();
            } catch {
              // If we can't get paths, continue with stat check
            }

            // Check if path exists via agent
            const stat = await agentStatPath(finalPath);

            if (!stat.isDir) {
              throw new Error('Custom drive path must be a directory');
            }

            // Verify the path is within one of the agent's configured paths
            if (agentPaths.length > 0) {
              const pathMatches = agentPaths.some(agentPath => {
                const normalizedAgentPath = require('path').resolve(agentPath);
                const normalizedFinalPath = require('path').resolve(finalPath);
                return (
                  normalizedFinalPath.startsWith(normalizedAgentPath + require('path').sep) ||
                  normalizedFinalPath === normalizedAgentPath
                );
              });

              if (!pathMatches) {
                throw new Error(
                  `Custom drive path ${finalPath} is not within any agent-configured path. ` +
                    `Add the path to the agent first using: tma-agent add --path <parent_path>`
                );
              }
            }
          } catch (error) {
            const { isAgentOfflineError } = require('../../utils/agentErrorDetection');
            if (isAgentOfflineError(error)) {
              throw new Error('Agent is offline. Please ensure the agent is running and configured in Settings.');
            }
            const errorMessage = error?.message || '';
            if (errorMessage.includes('not within any agent-configured path')) {
              throw error;
            } else if (errorMessage.includes('No such file or directory') || errorMessage.includes('does not exist')) {
              throw new Error(
                `Custom drive path does not exist: ${finalPath}. ` +
                  `Ensure the path exists on the host and add it to the agent using: tma-agent add --path ${finalPath}`
              );
            } else {
              throw new Error(`Cannot validate custom drive path via agent: ${errorMessage || 'Unknown error'}`);
            }
          }
        } else {
          // Agent not configured - validate path directly (for non-Docker setups without agent)
          const fs = require('fs').promises;
          try {
            const stats = await fs.stat(finalPath);
            if (!stats.isDirectory()) {
              throw new Error('Custom drive path must be a directory');
            }
            await fs.access(finalPath, fs.constants.R_OK | fs.constants.W_OK);
          } catch (error) {
            if (error.code === 'ENOENT') {
              throw new Error(`Custom drive path does not exist: ${finalPath}`);
            } else if (error.code === 'EACCES') {
              throw new Error(`No permission to access custom drive path: ${finalPath}`);
            } else if (!error.code) {
              throw error;
            } else {
              throw new Error(`Cannot access custom drive path: ${error.message || error.code}`);
            }
          }
        }
      }

      // Process ignore patterns
      const finalIgnorePatterns = ignorePatterns !== undefined ? ignorePatterns : currentSettings.ignorePatterns || [];

      // Update settings
      let result;
      try {
        result = await updateUserCustomDriveSettings(targetUserIdFinal, finalEnabled, finalPath, finalIgnorePatterns);
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
          await restartUserWatcher(targetUserIdFinal, finalPath, result.ignorePatterns || []);
        } catch (error) {
          logger.error(`[Custom Drive] Failed to restart watcher for user ${targetUserIdFinal}:`, error.message);
          // Don't fail the request, just log the error
        }
      } else {
        // Stop watcher if disabled
        const { restartUserWatcher } = require('../../services/customDriveScanner');
        try {
          await restartUserWatcher(targetUserIdFinal, null, []);
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
          ignorePatternsCount: updated.result.ignorePatterns?.length || 0,
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

/**
 * Check agent status for current user (non-admin endpoint)
 * Returns agent online status based on user's custom drive configuration
 * For users with custom drive enabled, returns the actual agent online status
 * For users without custom drive, returns true (agent not needed)
 */
async function checkMyAgentStatus(req, res) {
  try {
    const agentCheck = await checkAgentForUser(req.userId);
    // If agent is not required (user doesn't have custom drive), agent is "online" from their perspective
    if (!agentCheck.required) {
      return sendSuccess(res, { isOnline: true });
    }
    // If agent is required, return the actual online status
    // CRITICAL: Only return true if agent is explicitly confirmed online
    // This ensures users with custom drive get accurate agent status
    const isOnline = agentCheck.online === true;
    logger.debug(
      { userId: req.userId, required: agentCheck.required, online: agentCheck.online, isOnline },
      'Agent status check for user'
    );
    sendSuccess(res, { isOnline });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to check agent status for user');
    // On error, assume offline to be safe
    sendSuccess(res, { isOnline: false });
  }
}

module.exports = {
  getCustomDriveSettings,
  getAllUsersCustomDriveSettings,
  updateCustomDriveSettings,
  checkMyAgentStatus,
};
