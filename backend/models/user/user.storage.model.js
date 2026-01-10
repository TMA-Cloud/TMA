const pool = require('../../config/db');
const { getCache, setCache, cacheKeys } = require('../../utils/cache');

async function getUserStorageUsage(userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userStorage(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  // Include files in trash (deleted_at IS NOT NULL) as they still consume storage
  // Only permanently deleted files are excluded (they're removed from database entirely)
  const res = await pool.query(
    "SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = $1 AND type = 'file'",
    [userId]
  );
  const usage = Number(res.rows[0].used) || 0;

  // Cache the result (shorter TTL as storage usage changes with file operations)
  await setCache(cacheKey, usage, 120); // 2 minutes TTL

  return usage;
}

module.exports = {
  getUserStorageUsage,
};
