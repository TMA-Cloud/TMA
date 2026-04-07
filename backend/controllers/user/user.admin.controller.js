import { logger } from '../../config/logger.js';
import {
  getAllUsersBasic,
  getElectronOnlyAccessSettings,
  getHideFileExtensionsSettings,
  getMaxUploadSizeSettings,
  getOnlyOfficeSettings,
  getPasswordChangeSettings,
  getShareBaseUrlSettings,
  getSignupEnabled,
  getTotalUserCount,
  isFirstUser,
  setElectronOnlyAccessSettings,
  setHideFileExtensionsSettings,
  setMaxUploadSizeSettings,
  setOnlyOfficeSettings,
  setPasswordChangeSettings,
  setShareBaseUrlSettings,
  setSignupEnabled,
  setUserStorageLimit,
} from '../../models/user.model.js';
import { upsertClientHeartbeat, getActiveClients } from '../../models/clientHeartbeat.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { invalidateOnlyOfficeOriginCache } from '../../utils/onlyofficeOriginCache.js';
import { sendError, sendSuccess } from '../../utils/response.js';

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
    const [signupEnabled, hideFileExtensions, electronOnlyAccess, passwordChangeEnabled, userIsFirst] =
      await Promise.all([
        getSignupEnabled(),
        getHideFileExtensionsSettings(),
        getElectronOnlyAccessSettings(),
        getPasswordChangeSettings(),
        isFirstUser(req.userId),
      ]);
    let totalUsers;

    if (userIsFirst) {
      totalUsers = await getTotalUserCount();
    }

    sendSuccess(res, {
      signupEnabled,
      canToggle: userIsFirst,
      totalUsers,
      additionalUsers: typeof totalUsers === 'number' ? Math.max(totalUsers - 1, 0) : undefined,
      hideFileExtensions,
      canToggleHideFileExtensions: userIsFirst,
      electronOnlyAccess,
      canToggleElectronOnlyAccess: userIsFirst,
      allowPasswordChange: passwordChangeEnabled,
      canToggleAllowPasswordChange: userIsFirst,
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
 * Get max upload size config (any authenticated user; used by UI for display and validation)
 */
async function _getMaxUploadSizeConfig(req, res) {
  try {
    const settings = await getMaxUploadSizeSettings();
    sendSuccess(res, { maxBytes: settings.maxBytes });
  } catch (err) {
    logger.error({ err }, 'Failed to get max upload size config');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update max upload size config (admin only)
 */
async function _updateMaxUploadSizeConfig(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_max_upload_size_config', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized max upload size config update attempt');
      return sendError(res, 403, 'Only the first user can configure max upload size');
    }

    const { maxBytes } = req.body;

    await setMaxUploadSizeSettings(maxBytes, req.userId);

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'max_upload_size_config', maxBytes },
      },
      req
    );
    logger.info({ userId: req.userId, maxBytes }, 'Max upload size settings updated');

    const updatedSettings = await getMaxUploadSizeSettings();
    sendSuccess(res, { maxBytes: updatedSettings.maxBytes });
  } catch (err) {
    if (err.message === 'Only the first user can configure max upload size') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_max_upload_size_config' },
        },
        req
      );
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update max upload size settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get hide file extensions setting (any authenticated user; used by UI for display).
 * Update is admin only via _updateHideFileExtensionsConfig.
 */
async function _getHideFileExtensionsConfig(req, res) {
  try {
    const hideFileExtensions = await getHideFileExtensionsSettings();
    sendSuccess(res, { hideFileExtensions });
  } catch (err) {
    logger.error({ err }, 'Failed to get hide file extensions config');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update hide file extensions setting (admin only)
 */
async function _updateHideFileExtensionsConfig(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_hide_file_extensions', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized hide file extensions config update attempt');
      return sendError(res, 403, 'Only the first user can configure hide file extensions');
    }

    const { hidden } = req.body;

    await setHideFileExtensionsSettings(hidden, req.userId);

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'hide_file_extensions', hidden: !!hidden },
      },
      req
    );
    logger.info({ userId: req.userId, hidden: !!hidden }, 'Hide file extensions setting updated');

    const hideFileExtensions = await getHideFileExtensionsSettings();
    sendSuccess(res, { hideFileExtensions });
  } catch (err) {
    if (err.message === 'Only the first user can configure hide file extensions') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_hide_file_extensions' },
        },
        req
      );
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update hide file extensions settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get desktop-only access setting (any authenticated user; used by UI for display).
 * Update is admin-only via _updateElectronOnlyAccessConfig.
 */
async function _getElectronOnlyAccessConfig(req, res) {
  try {
    const electronOnlyAccess = await getElectronOnlyAccessSettings();
    sendSuccess(res, { electronOnlyAccess });
  } catch (err) {
    logger.error({ err }, 'Failed to get desktop-only access config');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update desktop-only access setting (admin only)
 */
async function _updateElectronOnlyAccessConfig(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_electron_only_access', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized desktop-only access config update attempt');
      return sendError(res, 403, 'Only the first user can configure desktop-only access');
    }

    const { enabled } = req.body;

    await setElectronOnlyAccessSettings(enabled, req.userId);

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'electron_only_access', enabled: !!enabled },
      },
      req
    );
    logger.info(
      { userId: req.userId, enabled: !!enabled },
      'Desktop-only access setting updated (require electron client)'
    );

    const electronOnlyAccess = await getElectronOnlyAccessSettings();
    sendSuccess(res, { electronOnlyAccess });
  } catch (err) {
    if (err.message === 'Only the first user can configure desktop-only access') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_electron_only_access' },
        },
        req
      );
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update desktop-only access settings');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get password change setting (any authenticated user; used by UI for display).
 * Update is admin-only via _updatePasswordChangeConfig.
 */
async function _getPasswordChangeConfig(req, res) {
  try {
    const allowPasswordChange = await getPasswordChangeSettings();
    sendSuccess(res, { allowPasswordChange });
  } catch (err) {
    logger.error({ err }, 'Failed to get password change config');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Update password change setting (admin only)
 */
async function _updatePasswordChangeConfig(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          metadata: { action: 'update_password_change', reason: 'unauthorized' },
        },
        req
      );
      logger.warn({ userId: req.userId }, 'Unauthorized password change config update attempt');
      return sendError(res, 403, 'Only the first user can configure password change');
    }

    const { enabled } = req.body;

    await setPasswordChangeSettings(enabled, req.userId);

    await logAuditEvent(
      'admin.settings.update',
      {
        status: 'success',
        resourceType: 'settings',
        metadata: { setting: 'allow_password_change', enabled: !!enabled },
      },
      req
    );
    logger.info(
      { userId: req.userId, enabled: !!enabled },
      'Password change setting updated (allow users to change passwords)'
    );

    const allowPasswordChange = await getPasswordChangeSettings();
    sendSuccess(res, { allowPasswordChange });
  } catch (err) {
    if (err.message === 'Only the first user can configure password change') {
      await logAuditEvent(
        'admin.settings.update',
        {
          status: 'failure',
          resourceType: 'settings',
          errorMessage: err.message,
          metadata: { action: 'update_password_change' },
        },
        req
      );
      return sendError(res, 403, err.message);
    }
    logger.error({ err }, 'Failed to update password change settings');
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

/**
 * Record a heartbeat from an Electron desktop client (any authenticated user)
 * The frontend calls this periodically when running inside Electron
 */
async function _clientHeartbeat(req, res) {
  try {
    const { appVersion, platform, sessionId, clientId } = req.body;
    if (!appVersion || typeof appVersion !== 'string') {
      return sendError(res, 400, 'appVersion is required');
    }

    await upsertClientHeartbeat({
      userId: req.userId,
      clientId: typeof clientId === 'string' && clientId.trim() ? clientId.trim() : null,
      sessionId: sessionId || req.sessionId || null,
      appVersion,
      platform: platform || null,
      userAgent: req.get('User-Agent') || null,
      ipAddress: req.ip || null,
    });

    sendSuccess(res, { ok: true });
  } catch (err) {
    logger.error({ err }, 'Failed to record client heartbeat');
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get all active Electron desktop clients (admin / first user only)
 */
async function _getActiveClients(req, res) {
  try {
    const userIsFirst = await isFirstUser(req.userId);
    if (!userIsFirst) {
      return sendError(res, 403, 'Only the first user can view active clients');
    }

    const clients = await getActiveClients(5);

    sendSuccess(res, {
      clients: clients.map(c => ({
        id: c.id,
        userId: c.user_id,
        userName: c.user_name,
        userEmail: c.user_email,
        appVersion: c.app_version,
        platform: c.platform,
        ipAddress: c.ip_address,
        lastSeenAt: c.last_seen_at,
        connectedSince: c.created_at,
      })),
    });
  } catch (err) {
    logger.error({ err }, 'Failed to fetch active clients');
    sendError(res, 500, 'Server error', err);
  }
}

export {
  _getPublicSignupStatus as getPublicSignupStatus,
  _getSignupStatus as getSignupStatus,
  _toggleSignup as toggleSignup,
  _listUsers as listUsers,
  _checkOnlyOfficeConfigured as checkOnlyOfficeConfigured,
  _getOnlyOfficeConfig as getOnlyOfficeConfig,
  _updateOnlyOfficeConfig as updateOnlyOfficeConfig,
  _getShareBaseUrlConfig as getShareBaseUrlConfig,
  _updateShareBaseUrlConfig as updateShareBaseUrlConfig,
  _getMaxUploadSizeConfig as getMaxUploadSizeConfig,
  _updateMaxUploadSizeConfig as updateMaxUploadSizeConfig,
  _getHideFileExtensionsConfig as getHideFileExtensionsConfig,
  _updateHideFileExtensionsConfig as updateHideFileExtensionsConfig,
  _updateUserStorageLimit as updateUserStorageLimit,
  _getElectronOnlyAccessConfig as getElectronOnlyAccessConfig,
  _updateElectronOnlyAccessConfig as updateElectronOnlyAccessConfig,
  _getPasswordChangeConfig as getPasswordChangeConfig,
  _updatePasswordChangeConfig as updatePasswordChangeConfig,
  _clientHeartbeat as clientHeartbeat,
  _getActiveClients as getActiveClients,
};
