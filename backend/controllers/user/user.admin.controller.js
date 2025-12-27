const {
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
  getOnlyOfficeSettings,
  setOnlyOfficeSettings,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { invalidateOnlyOfficeOriginCache } = require('../../utils/onlyofficeOriginCache');

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

    const users = (await getAllUsersBasic()).map(user => ({
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.created_at,
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

module.exports = {
  getSignupStatus,
  toggleSignup,
  listUsers,
  checkOnlyOfficeConfigured,
  getOnlyOfficeConfig,
  updateOnlyOfficeConfig,
};
