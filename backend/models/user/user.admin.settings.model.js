import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { getCache, setCache, deleteCache, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';
import { normalizeOnlyOfficeUrl } from '../../utils/onlyofficeUrl.js';
// Re-export from the canonical service to avoid duplication
import { getShareBaseUrlSettings } from '../../services/shareBaseUrl.service.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';

async function getSignupEnabled() {
  const cacheKey = cacheKeys.signupEnabled();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT signup_enabled FROM app_settings WHERE id = $1', ['app_settings']);
  let signupEnabled;
  if (result.rows.length === 0) {
    // No settings row yet: enable signup only if there are no users.
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count, 10);
    signupEnabled = userCount === 0;
  } else {
    signupEnabled = result.rows[0].signup_enabled;
  }

  await setCache(cacheKey, signupEnabled, DEFAULT_TTL);

  return signupEnabled;
}

async function setSignupEnabled(enabled, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'toggle signup');
    await client.query('UPDATE app_settings SET signup_enabled = $1, updated_at = NOW() WHERE id = $2', [
      enabled,
      'app_settings',
    ]);

    await client.query('COMMIT');

    await deleteCache(cacheKeys.signupEnabled());

    logger.info(`[SECURITY] Signup ${enabled ? 'enabled' : 'disabled'} by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getOnlyOfficeSettings() {
  const cacheKey = cacheKeys.onlyOfficeSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT onlyoffice_jwt_secret, onlyoffice_url FROM app_settings WHERE id = $1', [
    'app_settings',
  ]);

  const settings = {
    jwtSecret: null,
    url: null,
  };

  if (result.rows.length > 0) {
    settings.jwtSecret = result.rows[0].onlyoffice_jwt_secret || null;
    settings.url = result.rows[0].onlyoffice_url || null;
  }

  await setCache(cacheKey, settings, DEFAULT_TTL);

  return settings;
}

async function setOnlyOfficeSettings(jwtSecret, url, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure OnlyOffice');

    // Both fields together, or both empty.
    const hasJwtSecret = jwtSecret !== null;
    const hasUrl = url !== null;
    if (hasJwtSecret !== hasUrl) {
      await client.query('ROLLBACK');
      throw new Error('Both URL and JWT Secret must be provided together, or both must be empty');
    }

    if (jwtSecret !== null && (typeof jwtSecret !== 'string' || jwtSecret.trim().length === 0)) {
      await client.query('ROLLBACK');
      throw new Error('JWT secret must be a non-empty string or null');
    }

    if (url !== null && (typeof url !== 'string' || url.trim().length === 0)) {
      await client.query('ROLLBACK');
      throw new Error('OnlyOffice URL must be a non-empty string or null');
    }

    // OnlyOffice needs an absolute http/https URL (api.js, command service, CSP
    // origin); a scheme-less value silently breaks all three, so normalize/reject.
    let normalizedUrl = url;
    if (url !== null) {
      try {
        normalizedUrl = normalizeOnlyOfficeUrl(url);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(err?.message || 'Invalid OnlyOffice URL', { cause: err });
      }
    }

    await client.query(
      'UPDATE app_settings SET onlyoffice_jwt_secret = $1, onlyoffice_url = $2, updated_at = NOW() WHERE id = $3',
      [jwtSecret, normalizedUrl, 'app_settings']
    );

    await client.query('COMMIT');

    await deleteCache(cacheKeys.onlyOfficeSettings());

    logger.info(`[SECURITY] OnlyOffice settings updated by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setShareBaseUrlSettings(url, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure share base URL');

    // Validate the URL if provided.
    if (url !== null) {
      if (typeof url !== 'string' || url.trim().length === 0) {
        await client.query('ROLLBACK');
        throw new Error('Share base URL must be a non-empty string or null');
      }

      try {
        new URL(url.trim());
      } catch {
        await client.query('ROLLBACK');
        throw new Error('Invalid URL format');
      }
    }

    await client.query('UPDATE app_settings SET share_base_url = $1, updated_at = NOW() WHERE id = $2', [
      url ? url.trim() : null,
      'app_settings',
    ]);

    await client.query('COMMIT');

    await deleteCache(cacheKeys.shareBaseUrlSettings());

    logger.info(`[SECURITY] Share base URL settings updated by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Default max single-file upload size (10GB) when not set in DB */
const DEFAULT_MAX_UPLOAD_BYTES = 10 * 1024 * 1024 * 1024;

/** Min 1MB, max 100GB */
const MIN_MAX_UPLOAD_BYTES = 1024 * 1024;
const MAX_MAX_UPLOAD_BYTES = 100 * 1024 * 1024 * 1024;

async function getMaxUploadSizeSettings() {
  const cacheKey = cacheKeys.maxUploadSizeSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT max_upload_size_bytes FROM app_settings WHERE id = $1', ['app_settings']);

  let maxBytes = DEFAULT_MAX_UPLOAD_BYTES;
  if (result.rows.length > 0 && result.rows[0].max_upload_size_bytes != null) {
    const val = Number(result.rows[0].max_upload_size_bytes);
    if (Number.isInteger(val) && val >= MIN_MAX_UPLOAD_BYTES && val <= MAX_MAX_UPLOAD_BYTES) {
      maxBytes = val;
    }
  }

  const settings = { maxBytes };
  await setCache(cacheKey, settings, DEFAULT_TTL);
  return settings;
}

async function setMaxUploadSizeSettings(maxBytes, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure max upload size');

    const val = Number(maxBytes);
    if (!Number.isInteger(val) || val < MIN_MAX_UPLOAD_BYTES || val > MAX_MAX_UPLOAD_BYTES) {
      await client.query('ROLLBACK');
      throw new Error(`Max upload size must be between ${MIN_MAX_UPLOAD_BYTES} and ${MAX_MAX_UPLOAD_BYTES} bytes`);
    }

    await client.query('UPDATE app_settings SET max_upload_size_bytes = $1, updated_at = NOW() WHERE id = $2', [
      val,
      'app_settings',
    ]);

    await client.query('COMMIT');
    await deleteCache(cacheKeys.maxUploadSizeSettings());
    logger.info(`[SECURITY] Max upload size settings updated by first user (ID: ${userId}), maxBytes: ${val}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getHideFileExtensionsSettings() {
  const cacheKey = cacheKeys.hideFileExtensionsSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT hide_file_extensions FROM app_settings WHERE id = $1', ['app_settings']);
  const hidden = result.rows.length > 0 && result.rows[0].hide_file_extensions === true;
  await setCache(cacheKey, hidden, DEFAULT_TTL);
  return hidden;
}

async function setHideFileExtensionsSettings(hidden, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure hide file extensions');

    await client.query('UPDATE app_settings SET hide_file_extensions = $1, updated_at = NOW() WHERE id = $2', [
      !!hidden,
      'app_settings',
    ]);

    await client.query('COMMIT');
    await deleteCache(cacheKeys.hideFileExtensionsSettings());
    logger.info(`[SECURITY] Hide file extensions settings updated by first user (ID: ${userId}), hidden: ${!!hidden}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getElectronOnlyAccessSettings() {
  const cacheKey = cacheKeys.electronOnlyAccessSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT require_electron_client FROM app_settings WHERE id = $1', ['app_settings']);
  const enabled = result.rows.length > 0 && result.rows[0].require_electron_client === true;
  await setCache(cacheKey, enabled, DEFAULT_TTL);
  return enabled;
}

async function setElectronOnlyAccessSettings(enabled, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure desktop-only access');

    await client.query('UPDATE app_settings SET require_electron_client = $1, updated_at = NOW() WHERE id = $2', [
      !!enabled,
      'app_settings',
    ]);

    await client.query('COMMIT');
    await deleteCache(cacheKeys.electronOnlyAccessSettings());
    logger.info(`[SECURITY] Desktop-only access settings updated by first user (ID: ${userId}), enabled: ${!!enabled}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getPasswordChangeSettings() {
  const cacheKey = cacheKeys.passwordChangeSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const result = await pool.query('SELECT allow_password_change FROM app_settings WHERE id = $1', ['app_settings']);
  const enabled = result.rows.length > 0 && result.rows[0].allow_password_change === true;
  await setCache(cacheKey, enabled, DEFAULT_TTL);
  return enabled;
}

async function setPasswordChangeSettings(enabled, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure password change');

    await client.query('UPDATE app_settings SET allow_password_change = $1, updated_at = NOW() WHERE id = $2', [
      !!enabled,
      'app_settings',
    ]);

    await client.query('COMMIT');
    await deleteCache(cacheKeys.passwordChangeSettings());
    logger.info(`[SECURITY] Password change setting updated by first user (ID: ${userId}), enabled: ${!!enabled}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export {
  getSignupEnabled,
  setSignupEnabled,
  getOnlyOfficeSettings,
  setOnlyOfficeSettings,
  getShareBaseUrlSettings,
  setShareBaseUrlSettings,
  getMaxUploadSizeSettings,
  setMaxUploadSizeSettings,
  getHideFileExtensionsSettings,
  setHideFileExtensionsSettings,
  getElectronOnlyAccessSettings,
  setElectronOnlyAccessSettings,
  getPasswordChangeSettings,
  setPasswordChangeSettings,
};
