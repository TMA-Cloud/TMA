const pool = require('../../config/db');
const { logger } = require('../../config/logger');
const { getCache, setCache, deleteCache, cacheKeys, DEFAULT_TTL } = require('../../utils/cache');

/**
 * Get user's current token version for validation
 * @param {string} id - User ID
 * @returns {number|null} Token version or null if user not found
 */
async function getUserTokenVersion(id) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userTokenVersion(id);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT token_version FROM users WHERE id = $1', [id]);
  const tokenVersion = result.rows[0]?.token_version ?? null;

  // Cache the result (5 minutes TTL)
  if (tokenVersion !== null) {
    await setCache(cacheKey, tokenVersion, DEFAULT_TTL);
  }

  return tokenVersion;
}

/**
 * Invalidate all user sessions by incrementing token_version
 * @param {string} userId - User ID
 * @returns {number} New token version
 */
async function invalidateAllSessions(userId) {
  const result = await pool.query(
    `UPDATE users 
     SET token_version = token_version + 1, 
         last_token_invalidation = NOW() 
     WHERE id = $1 
     RETURNING token_version`,
    [userId]
  );
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  // Invalidate user cache when token version changes
  await deleteCache(cacheKeys.userById(userId));
  await deleteCache(cacheKeys.userTokenVersion(userId));

  logger.info({ userId }, 'All user sessions invalidated');
  return result.rows[0].token_version;
}

module.exports = {
  getUserTokenVersion,
  invalidateAllSessions,
};
