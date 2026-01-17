const {
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
  getOnlyOfficeSettings,
  setOnlyOfficeSettings,
  getAgentSettings,
  setAgentSettings,
  setUserStorageLimit,
  getUserStorageUsage,
  getUserStorageLimit,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { invalidateOnlyOfficeOriginCache } = require('../../utils/onlyofficeOriginCache');
const { getAgentPaths: fetchAgentPaths, checkAgentStatus, resetAgentStatus } = require('../../utils/agentClient');

/**
 * Get signup status and admin information
 */
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
      additionalUsers: typeof totalUsers === 'number' ? Math.max(totalUsers - 1, 0) : undefined,
    });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Toggle signup enabled/disabled (admin only)
 */
async function toggleSignup(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'toggle_signup', reason: 'unauthorized' },
        },
        req
      );
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
    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'signup_enabled', newValue: enabled },
      },
      req
    );
    logger.info({ userId: req.userId, signupEnabled: enabled }, 'Signup setting toggled');

    sendSuccess(res, { signupEnabled: enabled });
  } catch (err) {
    if (err.message === 'Only the first user can toggle signup') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'toggle_signup' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized signup toggle attempt');
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to toggle signup');
    sendError(res, 500, 'Server error', err);
  }
}

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
    const checkDiskSpace = require('check-disk-space').default;
    const { getUserCustomDriveSettings } = require('../../models/user.model');
    const basePath = process.env.UPLOAD_DIR || __dirname;
    const { size: defaultActualDiskSize } = await checkDiskSpace(basePath);

    // Fetch storage info for all users
    const users = await Promise.all(
      usersBasic.map(async user => {
        const used = await getUserStorageUsage(user.id);
        const storageLimit = await getUserStorageLimit(user.id);

        // Get actual disk size for this user (check custom drive if enabled)
        let actualDiskSize = defaultActualDiskSize;
        try {
          const customDrive = await getUserCustomDriveSettings(user.id);
          if (customDrive.enabled && customDrive.path) {
            // Only run expensive disk check if user has a custom drive
            const { getActualDiskSize } = require('../../utils/storageUtils');
            actualDiskSize = await getActualDiskSize(customDrive, basePath);
          }
          // Otherwise use defaultActualDiskSize already calculated outside the loop
        } catch (err) {
          // If custom drive check fails, use default
          logger.warn({ userId: user.id, err }, 'Failed to get custom drive disk size, using default');
        }

        // If no custom limit is set, use the actual available disk space
        const effectiveLimit = storageLimit !== null ? storageLimit : actualDiskSize;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          createdAt: user.created_at,
          mfaEnabled: user.mfa_enabled || false,
          storageUsed: used,
          storageLimit, // getUserStorageLimit already handles type conversion
          storageTotal: effectiveLimit,
          actualDiskSize, // Add actual disk size for validation
        };
      })
    );

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
 * Check if OnlyOffice is configured (all authenticated users)
 * Returns only whether it's configured, not the actual secrets
 */
async function checkOnlyOfficeConfigured(req, res) {
  try {
    const settings = await getOnlyOfficeSettings();
    const isConfigured = !!(settings.jwtSecret && settings.url);

    sendSuccess(res, {
      configured: isConfigured,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to check OnlyOffice configuration');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get OnlyOffice settings (admin only)
 */
async function getOnlyOfficeConfig(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.read',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'get_onlyoffice_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized OnlyOffice config read attempt');
      return sendError(res, 403, 'Only the first user can view OnlyOffice settings');
    }

    const settings = await getOnlyOfficeSettings();

    sendSuccess(res, {
      jwtSecretSet: settings.jwtSecret !== null && settings.jwtSecret !== undefined,
      url: settings.url,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get OnlyOffice settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update OnlyOffice settings (admin only)
 */
async function updateOnlyOfficeConfig(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_onlyoffice_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized OnlyOffice config update attempt');
      return sendError(res, 403, 'Only the first user can configure OnlyOffice');
    }

    const { jwtSecret, url } = req.body;

    // Normalize undefined to null for consistent validation
    const normalizedJwtSecret = jwtSecret !== undefined ? jwtSecret : null;
    const normalizedUrl = url !== undefined ? url : null;

    // Enforce "both or none" - both fields must be provided together or both must be null
    const hasJwtSecret = normalizedJwtSecret !== null;
    const hasUrl = normalizedUrl !== null;
    if (hasJwtSecret !== hasUrl) {
      return sendError(res, 400, 'Both URL and JWT Secret must be provided together, or both must be empty');
    }

    // Validate inputs (allow null to clear settings)
    if (
      normalizedJwtSecret !== null &&
      (typeof normalizedJwtSecret !== 'string' || normalizedJwtSecret.trim().length === 0)
    ) {
      return sendError(res, 400, 'JWT secret must be a non-empty string or null');
    }

    if (normalizedUrl !== null && (typeof normalizedUrl !== 'string' || normalizedUrl.trim().length === 0)) {
      return sendError(res, 400, 'OnlyOffice URL must be a non-empty string or null');
    }

    // Validate URL format if provided
    if (normalizedUrl !== null) {
      try {
        new URL(normalizedUrl);
      } catch {
        return sendError(res, 400, 'Invalid URL format');
      }
    }

    // setOnlyOfficeSettings will do additional security checks internally and invalidate cache
    await setOnlyOfficeSettings(normalizedJwtSecret, normalizedUrl, req.userId);

    // Invalidate in-memory CSP cache so new origin is used immediately
    invalidateOnlyOfficeOriginCache();

    // Log admin action
    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          setting: 'onlyoffice_config',
          hasJwtSecret: jwtSecret !== null && jwtSecret !== undefined,
          url: url || null,
        },
      },
      req
    );
    logger.info(
      { userId: req.userId, hasJwtSecret: !!normalizedJwtSecret, url: normalizedUrl },
      'OnlyOffice settings updated'
    );

    const updatedSettings = await getOnlyOfficeSettings();
    sendSuccess(res, {
      jwtSecretSet: updatedSettings.jwtSecret !== null && updatedSettings.jwtSecret !== undefined,
      url: updatedSettings.url,
    });
  } catch (err) {
    if (err.message === 'Only the first user can configure OnlyOffice') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_onlyoffice_config' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized OnlyOffice config update attempt');
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update OnlyOffice settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get agent settings (admin only)
 */
async function getAgentConfig(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.read',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'get_agent_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized agent config read attempt');
      return sendError(res, 403, 'Only the first user can view agent settings');
    }

    const settings = await getAgentSettings();

    sendSuccess(res, {
      tokenSet: settings.token !== null && settings.token !== undefined,
      url: settings.url,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get agent settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update agent settings (admin only)
 */
async function updateAgentConfig(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_agent_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized agent config update attempt');
      return sendError(res, 403, 'Only the first user can configure agent settings');
    }

    const { token, url } = req.body;

    // Normalize undefined to null for consistent validation
    const normalizedToken = token !== undefined ? token : null;
    const normalizedUrl = url !== undefined ? url : null;

    // Validate inputs (allow null to clear settings)
    if (normalizedToken !== null && (typeof normalizedToken !== 'string' || normalizedToken.trim().length === 0)) {
      return sendError(res, 400, 'Agent token must be a non-empty string or null');
    }

    if (normalizedUrl !== null && (typeof normalizedUrl !== 'string' || normalizedUrl.trim().length === 0)) {
      return sendError(res, 400, 'Agent URL must be a non-empty string or null');
    }

    // Validate URL format if provided
    if (normalizedUrl !== null) {
      try {
        new URL(normalizedUrl);
      } catch {
        return sendError(res, 400, 'Invalid URL format');
      }
    }

    // setAgentSettings will do additional security checks internally and invalidate cache
    await setAgentSettings(normalizedUrl, normalizedToken, req.userId);

    // Log admin action
    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          setting: 'agent_config',
          hasToken: normalizedToken !== null && normalizedToken !== undefined,
          url: normalizedUrl || null,
        },
      },
      req
    );
    logger.info({ userId: req.userId, hasToken: !!normalizedToken, url: normalizedUrl }, 'Agent settings updated');

    const updatedSettings = await getAgentSettings();
    sendSuccess(res, {
      tokenSet: updatedSettings.token !== null && updatedSettings.token !== undefined,
      url: updatedSettings.url,
    });
  } catch (err) {
    if (err.message === 'Only the first user can configure agent settings') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_agent_config', reason: 'unauthorized' },
        },
        req
      );
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update agent settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update user storage limit (admin only)
 */
async function updateUserStorageLimit(req, res) {
  try {
    // Verify user is first user before proceeding
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

    // Validate targetUserId: must be non-empty string, no special characters that could be dangerous
    if (!targetUserId || typeof targetUserId !== 'string' || targetUserId.trim().length === 0) {
      return sendError(res, 400, 'targetUserId is required and must be a non-empty string');
    }

    // Sanitize targetUserId: only allow alphanumeric, underscore, and hyphen (typical user ID format)
    if (!/^[a-zA-Z0-9_-]+$/.test(targetUserId)) {
      return sendError(res, 400, 'Invalid targetUserId format');
    }

    // Validate storage limit (must be positive integer or null)
    if (storageLimit !== null && storageLimit !== undefined) {
      // Ensure it's a number type
      if (typeof storageLimit !== 'number' && typeof storageLimit !== 'string') {
        return sendError(res, 400, 'Storage limit must be a number or null');
      }

      const limit = Number(storageLimit);

      // Validate: must be a finite integer, positive, and within safe range
      if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
        return sendError(res, 400, 'Storage limit must be a positive integer or null');
      }

      // Prevent extremely large values that could cause issues (max 1 PB = 1024^5 bytes)
      const MAX_STORAGE_LIMIT = 1024 * 1024 * 1024 * 1024 * 1024; // 1 Petabyte
      if (limit > MAX_STORAGE_LIMIT) {
        return sendError(res, 400, 'Storage limit cannot exceed 1 Petabyte (1125899906842624 bytes)');
      }

      // Ensure it's within JavaScript safe integer range
      if (limit > Number.MAX_SAFE_INTEGER) {
        return sendError(res, 400, 'Storage limit exceeds maximum safe value');
      }
    }

    // setUserStorageLimit will do additional security checks internally
    await setUserStorageLimit(req.userId, targetUserId, storageLimit === undefined ? null : storageLimit);

    // Log admin action
    await logAuditEvent(
      'admin.user.update',
      {
        status: 'success',
        resourceType: 'user',
        metadata: {
          action: 'update_storage_limit',
          targetUserId,
          storageLimit: storageLimit === undefined ? null : storageLimit,
        },
      },
      req
    );
    logger.info({ userId: req.userId, targetUserId, storageLimit }, 'User storage limit updated');

    sendSuccess(res, { storageLimit: storageLimit === undefined ? null : storageLimit });
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
    logger.error({ err }, 'Failed to update user storage limit');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Check agent status (admin only)
 */
async function checkAgentStatusEndpoint(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      return sendError(res, 403, 'Only the first user can check agent status');
    }

    const isOnline = await checkAgentStatus();
    sendSuccess(res, { isOnline });
  } catch (_err) {
    sendSuccess(res, { isOnline: false });
  }
}

/**
 * Reset agent status cache (admin only) - called when user clicks refresh
 */
async function resetAgentStatusEndpoint(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      return sendError(res, 403, 'Only the first user can reset agent status');
    }

    resetAgentStatus();
    const isOnline = await checkAgentStatus();
    sendSuccess(res, { isOnline });
  } catch (_err) {
    sendSuccess(res, { isOnline: false });
  }
}

/**
 * Get agent paths (admin only)
 */
async function getAgentPaths(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.read',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'get_agent_paths', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized agent paths read attempt');
      return sendError(res, 403, 'Only the first user can view agent paths');
    }

    const paths = await fetchAgentPaths();
    sendSuccess(res, { paths });
  } catch (err) {
    if (err.message === 'Agent URL not configured') {
      return sendSuccess(res, { paths: [] });
    }
    // Don't log errors - just return empty paths
    sendSuccess(res, { paths: [] });
  }
}

module.exports = {
  getSignupStatus,
  toggleSignup,
  listUsers,
  checkOnlyOfficeConfigured,
  getOnlyOfficeConfig,
  updateOnlyOfficeConfig,
  getAgentConfig,
  updateAgentConfig,
  getAgentPaths,
  checkAgentStatus: checkAgentStatusEndpoint,
  resetAgentStatus: resetAgentStatusEndpoint,
  updateUserStorageLimit,
};
