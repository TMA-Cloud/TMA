const {
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
  getOnlyOfficeSettings,
  setOnlyOfficeSettings,
  getShareBaseUrlSettings,
  setShareBaseUrlSettings,
  setUserStorageLimit,
} = require('../../models/user.model');
const { sendError, sendSuccess } = require('../../utils/response');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
const { invalidateOnlyOfficeOriginCache } = require('../../utils/onlyofficeOriginCache');

/**
 * Get public signup status (no auth). Returns only signupEnabled for login page.
 */
async function _getPublicSignupStatus(req, res) {
  try {
    const signupEnabled = await getSignupEnabled();
    sendSuccess(res, { signupEnabled });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get signup status and admin information (authenticated). Returns canToggle and user counts for first user.
 */
async function _getSignupStatus(req, res) {
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
async function _toggleSignup(req, res) {
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
async function _listUsers(req, res) {
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
async function _checkOnlyOfficeConfigured(req, res) {
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
async function _getOnlyOfficeConfig(req, res) {
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
async function _updateOnlyOfficeConfig(req, res) {
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

    // Enforce "both or none" - both fields must be provided together or both must be null
    if ((jwtSecret && !url) || (!jwtSecret && url)) {
      return sendError(res, 400, 'Both URL and JWT Secret must be provided together, or both must be empty');
    }

    // setOnlyOfficeSettings will do additional security checks internally and invalidate cache
    await setOnlyOfficeSettings(jwtSecret, url, req.userId);

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
    logger.info({ userId: req.userId, hasJwtSecret: !!jwtSecret, url }, 'OnlyOffice settings updated');

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
 * Get share base URL settings (admin only)
 */
async function _getShareBaseUrlConfig(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.read',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'get_share_base_url_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized share base URL config read attempt');
      return sendError(res, 403, 'Only the first user can view share base URL settings');
    }

    const settings = await getShareBaseUrlSettings();

    sendSuccess(res, {
      url: settings.url,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to get share base URL settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update share base URL settings (admin only)
 */
async function _updateShareBaseUrlConfig(req, res) {
  try {
    // Verify user is first user before proceeding
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_share_base_url_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized share base URL config update attempt');
      return sendError(res, 403, 'Only the first user can configure share base URL');
    }

    const { url } = req.body;

    // setShareBaseUrlSettings will do additional security checks internally and invalidate Redis cache
    // All instances will automatically get the new value from Redis on next request
    await setShareBaseUrlSettings(url, req.userId);

    // Log admin action
    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: {
          setting: 'share_base_url_config',
          url: url || null,
        },
      },
      req
    );
    logger.info({ userId: req.userId, url }, 'Share base URL settings updated');

    const updatedSettings = await getShareBaseUrlSettings();
    sendSuccess(res, {
      url: updatedSettings.url,
    });
  } catch (err) {
    if (err.message === 'Only the first user can configure share base URL') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_share_base_url_config' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized share base URL config update attempt');
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update share base URL settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update user storage limit (admin only)
 */
async function _updateUserStorageLimit(req, res) {
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
    if (err.message?.startsWith('Storage limit') || err.message === 'Invalid targetUserId format') {
      logger.warn({ err, userId: req.userId }, 'Storage limit update rejected');
      return sendError(res, 400, err.message);
    }
    logger.error({ err }, 'Failed to update user storage limit');
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  getPublicSignupStatus: _getPublicSignupStatus,
  getSignupStatus: _getSignupStatus,
  toggleSignup: _toggleSignup,
  listUsers: _listUsers,
  checkOnlyOfficeConfigured: _checkOnlyOfficeConfigured,
  getOnlyOfficeConfig: _getOnlyOfficeConfig,
  updateOnlyOfficeConfig: _updateOnlyOfficeConfig,
  getShareBaseUrlConfig: _getShareBaseUrlConfig,
  updateShareBaseUrlConfig: _updateShareBaseUrlConfig,
  updateUserStorageLimit: _updateUserStorageLimit,
};
