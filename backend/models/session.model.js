const pool = require('../config/db');
const { generateId } = require('../utils/id');
const { logger } = require('../config/logger');
const { getCache, setCache, deleteCache, deleteCachePattern, cacheKeys, DEFAULT_TTL } = require('../utils/cache');

/**
 * Create a new session record
 * @param {string} userId - User ID
 * @param {number} tokenVersion - Current token version
 * @param {string} userAgent - User agent string
 * @param {string} ipAddress - IP address
 * @returns {Promise<Object>} Created session
 */
async function createSession(userId, tokenVersion, userAgent, ipAddress) {
  const id = generateId(16);
  const result = await pool.query(
    `INSERT INTO sessions(id, user_id, token_version, user_agent, ip_address, created_at, last_activity)
     VALUES($1, $2, $3, $4, $5, NOW(), NOW())
     RETURNING id, user_id, token_version, user_agent, ip_address, created_at, last_activity`,
    [id, userId, tokenVersion, userAgent || null, ipAddress || null]
  );

  // Invalidate active sessions cache
  await deleteCache(cacheKeys.activeSessions(userId, tokenVersion));

  return result.rows[0];
}

/**
 * Check if a session exists and is valid
 * @param {string} sessionId - Session ID
 * @param {string} userId - User ID
 * @param {number} tokenVersion - Token version
 * @returns {Promise<boolean>} True if session exists and is valid
 */
async function sessionExists(sessionId, userId, tokenVersion) {
  // Try to get from cache first
  const cacheKey = cacheKeys.session(sessionId, userId, tokenVersion);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query(
    `SELECT id FROM sessions 
     WHERE id = $1 AND user_id = $2 AND token_version = $3`,
    [sessionId, userId, tokenVersion]
  );
  const exists = result.rows.length > 0;

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, exists, DEFAULT_TTL);

  return exists;
}

/**
 * Get all active sessions for a user
 * Active sessions are those with the current token_version
 * @param {string} userId - User ID
 * @param {number} currentTokenVersion - Current token version
 * @returns {Promise<Array>} Array of active sessions
 */
async function getActiveSessions(userId, currentTokenVersion) {
  // Try to get from cache first
  const cacheKey = cacheKeys.activeSessions(userId, currentTokenVersion);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query(
    `SELECT id, user_id, token_version, user_agent, ip_address, created_at, last_activity
     FROM sessions
     WHERE user_id = $1 AND token_version = $2
     ORDER BY last_activity DESC`,
    [userId, currentTokenVersion]
  );
  const sessions = result.rows;

  // Cache the result (2 minutes TTL)
  await setCache(cacheKey, sessions, 120);

  return sessions;
}

/**
 * Update last activity timestamp for a session
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function updateSessionActivity(sessionId) {
  await pool.query('UPDATE sessions SET last_activity = NOW() WHERE id = $1', [sessionId]);
}

/**
 * Delete a specific session
 * @param {string} sessionId - Session ID
 * @param {string} userId - User ID (for security check)
 * @returns {Promise<boolean>} True if session was deleted
 */
async function deleteSession(sessionId, userId) {
  // Get token version before deleting for cache invalidation
  const sessionResult = await pool.query('SELECT token_version FROM sessions WHERE id = $1 AND user_id = $2', [
    sessionId,
    userId,
  ]);
  const tokenVersion = sessionResult.rows[0]?.token_version;

  const result = await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id', [
    sessionId,
    userId,
  ]);
  const deleted = result.rows.length > 0;

  // Invalidate cache
  if (deleted && tokenVersion !== undefined) {
    await deleteCache(cacheKeys.session(sessionId, userId, tokenVersion));
    await deleteCache(cacheKeys.activeSessions(userId, tokenVersion));
  }

  return deleted;
}

/**
 * Delete all sessions for a user (used when invalidating all sessions)
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function deleteAllUserSessions(userId) {
  // Get token version before deleting for cache invalidation
  const sessionsResult = await pool.query('SELECT DISTINCT token_version FROM sessions WHERE user_id = $1', [userId]);
  const tokenVersions = sessionsResult.rows.map(r => r.token_version);

  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);

  // Invalidate cache for all token versions
  for (const tokenVersion of tokenVersions) {
    await deleteCache(cacheKeys.activeSessions(userId, tokenVersion));
  }
  await deleteCachePattern(`session:${userId}:*`);

  logger.info({ userId }, 'All user sessions deleted');
}

/**
 * Clean up old sessions (sessions with outdated token versions)
 * This should be run periodically to keep the table clean
 * @param {number} daysOld - Delete sessions older than this many days
 * @returns {Promise<number>} Number of sessions deleted
 */
async function cleanupOldSessions(daysOld = 30) {
  const result = await pool.query(
    `DELETE FROM sessions
     WHERE created_at < NOW() - INTERVAL '${daysOld} days'`,
    []
  );
  const deletedCount = result.rowCount || 0;
  if (deletedCount > 0) {
    logger.info({ deletedCount, daysOld }, 'Cleaned up old sessions');
  }
  return deletedCount;
}

module.exports = {
  createSession,
  sessionExists,
  getActiveSessions,
  updateSessionActivity,
  deleteSession,
  deleteAllUserSessions,
  cleanupOldSessions,
};
