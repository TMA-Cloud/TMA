const pool = require('../config/db');
const { getCache, setCache, cacheKeys, DEFAULT_TTL } = require('../utils/cache');
const { logger } = require('../config/logger');

/**
 * Get share base URL settings from database
 * This service is separate from shareLink.js to avoid circular dependencies
 */
async function getShareBaseUrlSettings() {
  // Try to get from cache first
  const cacheKey = cacheKeys.shareBaseUrlSettings();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT share_base_url FROM app_settings WHERE id = $1', ['app_settings']);

  const settings = {
    url: null,
  };

  if (result.rows.length > 0) {
    settings.url = result.rows[0].share_base_url || null;
  }

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, settings, DEFAULT_TTL);

  return settings;
}

/**
 * Get share base URL origin (parsed and validated)
 * Returns null if not configured or invalid
 */
async function getShareBaseUrlOrigin() {
  try {
    const settings = await getShareBaseUrlSettings();
    if (settings.url) {
      try {
        return new URL(settings.url.trim()).origin;
      } catch (error) {
        logger.warn({ err: error, shareBaseUrl: settings.url }, 'Invalid share base URL from database');
        return null;
      }
    }
    return null;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to load share base URL from database');
    return null;
  }
}

/**
 * Get share base host from configured URL
 * Returns null if not configured
 */
async function getShareBaseHost() {
  const origin = await getShareBaseUrlOrigin();
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

module.exports = {
  getShareBaseUrlSettings,
  getShareBaseUrlOrigin,
  getShareBaseHost,
};
