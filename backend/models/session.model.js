const pool = require('../config/db');
const { generateId } = require('../utils/id');
const { logger } = require('../config/logger');

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
  const result = await pool.query(
    `SELECT id FROM sessions 
     WHERE id = $1 AND user_id = $2 AND token_version = $3`,
    [sessionId, userId, tokenVersion]
  );
  return result.rows.length > 0;
}

/**
 * Get all active sessions for a user
 * Active sessions are those with the current token_version
 * @param {string} userId - User ID
 * @param {number} currentTokenVersion - Current token version
 * @returns {Promise<Array>} Array of active sessions
 */
async function getActiveSessions(userId, currentTokenVersion) {
  const result = await pool.query(
    `SELECT id, user_id, token_version, user_agent, ip_address, created_at, last_activity
     FROM sessions
     WHERE user_id = $1 AND token_version = $2
     ORDER BY last_activity DESC`,
    [userId, currentTokenVersion]
  );
  return result.rows;
}

/**
 * Update last activity timestamp for a session
 * @param {string} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function updateSessionActivity(sessionId) {
  await pool.query(
    'UPDATE sessions SET last_activity = NOW() WHERE id = $1',
    [sessionId]
  );
}

/**
 * Delete a specific session
 * @param {string} sessionId - Session ID
 * @param {string} userId - User ID (for security check)
 * @returns {Promise<boolean>} True if session was deleted
 */
async function deleteSession(sessionId, userId) {
  const result = await pool.query(
    'DELETE FROM sessions WHERE id = $1 AND user_id = $2 RETURNING id',
    [sessionId, userId]
  );
  return result.rows.length > 0;
}

/**
 * Delete all sessions for a user (used when invalidating all sessions)
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function deleteAllUserSessions(userId) {
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
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
