import { logger } from '../../config/logger.js';
import {
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
} from '../../models/user.model.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { invalidateOnlyOfficeOriginCache } from '../../utils/onlyofficeOriginCache.js';
import { sendError, sendSuccess } from '../../utils/response.js';

/**
 * Get public signup status (no auth). Returns only signupEnabled for login page.
 */
async function getPublicSignupStatus(req, res) {
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
async function getSignupStatus(req, res) {
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
async function toggleSignup(req, res) {
  try {
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

    await setSignupEnabled(enabled, req.userId);

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

    // Both fields together, or both empty.
    if ((jwtSecret && !url) || (!jwtSecret && url)) {
      return sendError(res, 400, 'Both URL and JWT Secret must be provided together, or both must be empty');
    }

    await setOnlyOfficeSettings(jwtSecret, url, req.userId);

    // Refresh the in-memory CSP cache so the new origin takes effect at once.
    invalidateOnlyOfficeOriginCache();

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
async function getShareBaseUrlConfig(req, res) {
  try {
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
async function updateShareBaseUrlConfig(req, res) {
  try {
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

    // Invalidates the Redis cache, so all instances pick up the new value.
    await setShareBaseUrlSettings(url, req.userId);

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
async function getMaxUploadSizeConfig(req, res) {
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
async function updateMaxUploadSizeConfig(req, res) {
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
 * Update is admin only via updateHideFileExtensionsConfig.
 */
async function getHideFileExtensionsConfig(req, res) {
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
async function updateHideFileExtensionsConfig(req, res) {
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
 * Update is admin-only via updateElectronOnlyAccessConfig.
 */
async function getElectronOnlyAccessConfig(req, res) {
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
async function updateElectronOnlyAccessConfig(req, res) {
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
 * Update is admin-only via updatePasswordChangeConfig.
 */
async function getPasswordChangeConfig(req, res) {
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
async function updatePasswordChangeConfig(req, res) {
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

export {
  getPublicSignupStatus,
  getSignupStatus,
  toggleSignup,
  checkOnlyOfficeConfigured,
  getOnlyOfficeConfig,
  updateOnlyOfficeConfig,
  getShareBaseUrlConfig,
  updateShareBaseUrlConfig,
  getMaxUploadSizeConfig,
  updateMaxUploadSizeConfig,
  getHideFileExtensionsConfig,
  updateHideFileExtensionsConfig,
  getElectronOnlyAccessConfig,
  updateElectronOnlyAccessConfig,
  getPasswordChangeConfig,
  updatePasswordChangeConfig,
};
