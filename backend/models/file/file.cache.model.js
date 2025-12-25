const { getUserCustomDriveSettings } = require('../user.model');
const { getCache, setCache, deleteCache, cacheKeys } = require('../../utils/cache');

/**
 * Invalidate custom drive cache for a specific user
 * Call this when custom drive settings are updated to ensure fresh data
 * @param {string} userId - User ID
 */
async function invalidateCustomDriveCache(userId) {
  await deleteCache(cacheKeys.customDrive(userId));
}

/**
 * Get user custom drive settings with caching
 */
async function getUserCustomDrive(userId) {
  // Try to get from Redis cache first
  const cacheKey = cacheKeys.customDrive(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  try {
    const settings = await getUserCustomDriveSettings(userId);
    // Cache the result (1 minute TTL)
    await setCache(cacheKey, settings, 60);
    return settings;
  } catch (_error) {
    // If user not found or error, return disabled
    const defaultSettings = { enabled: false, path: null };
    // Cache the default to avoid repeated queries
    await setCache(cacheKey, defaultSettings, 60);
    return defaultSettings;
  }
}

module.exports = {
  getUserCustomDrive,
  invalidateCustomDriveCache,
};
