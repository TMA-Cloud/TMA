const pool = require('../../config/db');
const { getCache, setCache, cacheKeys } = require('../../utils/cache');

/**
 * Get total storage usage for a user (sum of file sizes in DB).
 * Includes files in trash (deleted_at IS NOT NULL) as they still consume storage.
 */
async function getUserStorageUsage(userId) {
  const cacheKey = cacheKeys.userStorage(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  const res = await pool.query(
    "SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = $1 AND type = 'file'",
    [userId]
  );
  const usage = Number(res.rows[0].used) || 0;

  await setCache(cacheKey, usage, 120); // 2 minutes TTL

  return usage;
}

module.exports = {
  getUserStorageUsage,
};
