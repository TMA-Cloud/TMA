import path from 'path';
import { fileURLToPath } from 'url';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { useS3 } from '../../config/storage.js';
import { getCache, setCache, deleteCache, cacheKeys, DEFAULT_TTL } from '../../utils/cache.js';
import { getActualDiskSize, formatFileSize } from '../../utils/storageUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Verify the requesting user is the first user (admin) within a transaction.
 * Sets first_user_id atomically if not yet stored.
 * @param {import('pg').PoolClient} client - Active DB transaction client
 * @param {string} userId - Requesting user ID
 * @param {string} actionLabel - Human-readable action name for error messages
 */
async function verifyFirstUser(client, userId, actionLabel = 'perform this action') {
  const settingsResult = await client.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);
  if (settingsResult.rows.length === 0) {
    throw new Error('App settings not found');
  }

  const storedFirstUserId = settingsResult.rows[0].first_user_id;

  if (!storedFirstUserId) {
    const firstUserResult = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1 FOR UPDATE');
    if (firstUserResult.rows.length === 0) {
      throw new Error('No users exist');
    }
    if (firstUserResult.rows[0].id !== userId) {
      throw new Error(`Only the first user can ${actionLabel}`);
    }
    await client.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
      firstUserResult.rows[0].id,
      'app_settings',
    ]);
  } else if (storedFirstUserId !== userId) {
    throw new Error(`Only the first user can ${actionLabel}`);
  }
}

async function isFirstUser(userId) {
  // Use stored first_user_id as source of truth (immutable, cannot be manipulated)
  const result = await pool.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);

  if (result.rows.length === 0 || !result.rows[0].first_user_id) {
    // If no first user is set, check if this is the first user by created_at
    // This handles the case where migration runs before first user is created
    const firstUserResult = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    if (firstUserResult.rows.length === 0) {
      return false; // No users exist
    }
    const isFirst = firstUserResult.rows[0].id === userId;

    // If this is the first user and not yet stored, store it (one-time operation)
    if (isFirst) {
      try {
        await pool.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
          userId,
          'app_settings',
        ]);
      } catch (err) {
        // Ignore if another request already set it (race condition handled)
        logger.warn('Could not set first_user_id (may already be set):', err.message);
      }
    }
    return isFirst;
  }

  // Compare with stored first_user_id (immutable source of truth)
  return result.rows[0].first_user_id === userId;
}

async function getSignupEnabled() {
  // Try to get from cache first
  const cacheKey = cacheKeys.signupEnabled();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT signup_enabled FROM app_settings WHERE id = $1', ['app_settings']);
  let signupEnabled;
  if (result.rows.length === 0) {
    // If settings don't exist, check if any users exist
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count, 10);
    // If no users exist, signup should be enabled
    signupEnabled = userCount === 0;
  } else {
    signupEnabled = result.rows[0].signup_enabled;
  }

  // Cache the result (5 minutes TTL - changes infrequently)
  await setCache(cacheKey, signupEnabled, DEFAULT_TTL);

  return signupEnabled;
}

async function getTotalUserCount() {
  // Try to get from cache first
  const cacheKey = cacheKeys.userCount();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT COUNT(*) AS count FROM users');
  const count = Number(result.rows[0]?.count || 0);

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, count, DEFAULT_TTL);

  return count;
}

async function getAllUsersBasic() {
  // Admin-only endpoint — query DB directly; cache invalidation key kept for consistency
  const result = await pool.query(
    'SELECT id, email, name, created_at, mfa_enabled, storage_limit FROM users ORDER BY created_at ASC'
  );
  return result.rows;
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

    // Invalidate signup enabled cache
    await deleteCache(cacheKeys.signupEnabled());

    // Log security event
    logger.info(`[SECURITY] Signup ${enabled ? 'enabled' : 'disabled'} by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getOnlyOfficeSettings() {
  // Try to get from cache first
  const cacheKey = cacheKeys.onlyOfficeSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
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

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, settings, DEFAULT_TTL);

  return settings;
}

async function setOnlyOfficeSettings(jwtSecret, url, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure OnlyOffice');

    // Enforce "both or none" - both fields must be provided together or both must be null
    const hasJwtSecret = jwtSecret !== null;
    const hasUrl = url !== null;
    if (hasJwtSecret !== hasUrl) {
      await client.query('ROLLBACK');
      throw new Error('Both URL and JWT Secret must be provided together, or both must be empty');
    }

    // Validate inputs
    if (jwtSecret !== null && (typeof jwtSecret !== 'string' || jwtSecret.trim().length === 0)) {
      await client.query('ROLLBACK');
      throw new Error('JWT secret must be a non-empty string or null');
    }

    if (url !== null && (typeof url !== 'string' || url.trim().length === 0)) {
      await client.query('ROLLBACK');
      throw new Error('OnlyOffice URL must be a non-empty string or null');
    }

    // Update OnlyOffice settings
    await client.query(
      'UPDATE app_settings SET onlyoffice_jwt_secret = $1, onlyoffice_url = $2, updated_at = NOW() WHERE id = $3',
      [jwtSecret, url, 'app_settings']
    );

    await client.query('COMMIT');

    // Invalidate OnlyOffice settings cache
    await deleteCache(cacheKeys.onlyOfficeSettings());

    // Log security event
    logger.info(`[SECURITY] OnlyOffice settings updated by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Re-export from the canonical service to avoid duplication
import { getShareBaseUrlSettings } from '../../services/shareBaseUrl.service.js';

async function setShareBaseUrlSettings(url, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure share base URL');

    // Validate URL format if provided
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

    // Update share base URL setting
    await client.query('UPDATE app_settings SET share_base_url = $1, updated_at = NOW() WHERE id = $2', [
      url ? url.trim() : null,
      'app_settings',
    ]);

    await client.query('COMMIT');

    // Invalidate share base URL settings cache
    await deleteCache(cacheKeys.shareBaseUrlSettings());

    // Log security event
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

/**
 * Handle first user setup: set first_user_id and disable signup atomically
 * This is called after a new user is created to ensure the first user is properly set
 * @param {string} userId - User ID of the newly created user
 * @returns {Promise<void>}
 */
async function handleFirstUserSetup(userId) {
  const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
  const userCount = parseInt(userCountResult.rows[0].count, 10);

  if (userCount === 1) {
    // This is the first user, set first_user_id and disable signup atomically
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Set first_user_id (immutable after this)
      await client.query(
        'UPDATE app_settings SET first_user_id = $1, signup_enabled = false, updated_at = NOW() WHERE id = $2 AND first_user_id IS NULL',
        [userId, 'app_settings']
      );

      await client.query('COMMIT');
      logger.info({ userId }, 'First user created, signup disabled by default');
    } catch (_err) {
      await client.query('ROLLBACK');
      // If first_user_id already set, just disable signup
      await setSignupEnabled(false, userId);
    } finally {
      client.release();
    }
  }
}

async function getUserStorageLimit(userId) {
  const result = await pool.query('SELECT storage_limit FROM users WHERE id = $1', [userId]);
  if (result.rows.length === 0) {
    return null;
  }
  const limit = result.rows[0].storage_limit;
  // PostgreSQL BIGINT can be returned as string for very large numbers
  // Convert to number if it's a valid number string, otherwise return as-is (null or number)
  if (limit === null || limit === undefined) {
    return null;
  }
  // If it's already a number, return it
  if (typeof limit === 'number') {
    return limit;
  }
  // If it's a string representation of a number, convert it
  if (typeof limit === 'string') {
    const numLimit = Number(limit);
    return Number.isFinite(numLimit) ? numLimit : null;
  }
  return limit;
}

async function setUserStorageLimit(userId, targetUserId, storageLimit) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'set storage limits');

    // Validate storage limit (must be positive integer or null)
    if (storageLimit !== null) {
      const limit = Number(storageLimit);

      // Validate: must be a finite integer, positive, and within safe range
      if (!Number.isFinite(limit) || !Number.isInteger(limit) || limit <= 0) {
        await client.query('ROLLBACK');
        throw new Error('Storage limit must be a positive integer or null');
      }

      // Prevent extremely large values (max 1 PB)
      const MAX_STORAGE_LIMIT = 1024 * 1024 * 1024 * 1024 * 1024; // 1 Petabyte
      if (limit > MAX_STORAGE_LIMIT) {
        await client.query('ROLLBACK');
        throw new Error('Storage limit cannot exceed 1 Petabyte');
      }

      // Ensure it's within JavaScript safe integer range
      if (limit > Number.MAX_SAFE_INTEGER) {
        await client.query('ROLLBACK');
        throw new Error('Storage limit exceeds maximum safe value');
      }

      // When using local disk, cap limit by actual VM disk space. When using S3, skip this (S3 capacity is independent).
      if (!useS3) {
        const basePath = process.env.UPLOAD_DIR || __dirname;
        const actualDiskSize = await getActualDiskSize(basePath);
        if (limit > actualDiskSize) {
          const limitFormatted = formatFileSize(limit);
          const actualFormatted = formatFileSize(actualDiskSize);
          await client.query('ROLLBACK');
          throw new Error(`Storage limit (${limitFormatted}) cannot exceed actual disk space (${actualFormatted})`);
        }
      }
    }

    // Validate targetUserId format (additional safety check)
    if (!targetUserId || typeof targetUserId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(targetUserId)) {
      await client.query('ROLLBACK');
      throw new Error('Invalid targetUserId format');
    }

    // Update user storage limit using parameterized query (prevents SQL injection)
    await client.query('UPDATE users SET storage_limit = $1 WHERE id = $2', [storageLimit, targetUserId]);

    await client.query('COMMIT');

    // Invalidate user cache
    await deleteCache(cacheKeys.allUsers());
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
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
  getOnlyOfficeSettings,
  setOnlyOfficeSettings,
  getShareBaseUrlSettings,
  setShareBaseUrlSettings,
  getMaxUploadSizeSettings,
  setMaxUploadSizeSettings,
  getHideFileExtensionsSettings,
  setHideFileExtensionsSettings,
  handleFirstUserSetup,
  getUserStorageLimit,
  setUserStorageLimit,
  getElectronOnlyAccessSettings,
  setElectronOnlyAccessSettings,
  getPasswordChangeSettings,
  setPasswordChangeSettings,
};
