import pool from '../config/db.js';
import { logger } from '../config/logger.js';

/**
 * Upsert a client heartbeat
 * Identity precedence:
 * 1) Stable clientId (new clients) so each desktop install is unique
 * 2) sessionId (compatibility with older clients)
 * 3) fallback "no-session"
 */
async function upsertClientHeartbeat({ userId, clientId, sessionId, appVersion, platform, userAgent, ipAddress }) {
  const uniqueKey = clientId || sessionId || 'no-session';
  const id = `${userId}:${uniqueKey}`;
  const result = await pool.query(
    `INSERT INTO client_heartbeats (id, user_id, session_id, app_version, platform, user_agent, ip_address, last_seen_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
     ON CONFLICT (id) DO UPDATE
       SET app_version  = EXCLUDED.app_version,
           platform     = EXCLUDED.platform,
           user_agent   = EXCLUDED.user_agent,
           ip_address   = EXCLUDED.ip_address,
           last_seen_at = NOW()
     RETURNING *`,
    [id, userId, sessionId || null, appVersion, platform || null, userAgent || null, ipAddress || null]
  );
  return result.rows[0];
}

/**
 * Get all active Electron clients seen within the given window (default 5 min)
 * Joins with users to include the user name / email
 */
async function getActiveClients(withinMinutes = 5) {
  const result = await pool.query(
    `SELECT
       h.id,
       h.user_id,
       u.name  AS user_name,
       u.email AS user_email,
       h.app_version,
       h.platform,
       h.ip_address,
       h.last_seen_at,
       h.created_at
     FROM client_heartbeats h
     JOIN users u ON u.id = h.user_id
     WHERE h.last_seen_at > NOW() - INTERVAL '1 minute' * $1
     ORDER BY h.last_seen_at DESC`,
    [withinMinutes]
  );
  return result.rows;
}

/**
 * Purge stale heartbeats older than the given number of minutes
 * Called periodically to keep the table small
 */
async function purgeStaleHeartbeats(olderThanMinutes = 10) {
  const result = await pool.query(
    `DELETE FROM client_heartbeats WHERE last_seen_at < NOW() - INTERVAL '1 minute' * $1`,
    [olderThanMinutes]
  );
  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    logger.info({ deleted, olderThanMinutes }, 'Purged stale client heartbeats');
  }
  return deleted;
}

async function deleteHeartbeatBySession(userId, sessionId) {
  if (!userId || !sessionId) return 0;
  const result = await pool.query('DELETE FROM client_heartbeats WHERE user_id = $1 AND session_id = $2', [
    userId,
    sessionId,
  ]);
  return result.rowCount || 0;
}

async function deleteAllHeartbeatsForUser(userId) {
  if (!userId) return 0;
  const result = await pool.query('DELETE FROM client_heartbeats WHERE user_id = $1', [userId]);
  return result.rowCount || 0;
}

async function deleteOtherHeartbeatsForUser(userId, currentSessionId) {
  if (!userId || !currentSessionId) return 0;
  const result = await pool.query(
    'DELETE FROM client_heartbeats WHERE user_id = $1 AND (session_id IS NULL OR session_id != $2)',
    [userId, currentSessionId]
  );
  return result.rowCount || 0;
}

export {
  upsertClientHeartbeat,
  getActiveClients,
  purgeStaleHeartbeats,
  deleteHeartbeatBySession,
  deleteAllHeartbeatsForUser,
  deleteOtherHeartbeatsForUser,
};
