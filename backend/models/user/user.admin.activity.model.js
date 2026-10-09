import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import {
  activitySettingsFromRow,
  normalizeAccessTimeSettings,
  normalizeSessionIdleDays,
} from '../../utils/activitySettings.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';

const SELECT_ACTIVITY_SETTINGS = `SELECT session_idle_days, access_time_tracking, access_time_window_minutes,
        access_time_flush_seconds
   FROM app_settings WHERE id = 'app_settings'`;

async function loadActivitySettings(client = pool) {
  const result = await client.query(SELECT_ACTIVITY_SETTINGS);
  return activitySettingsFromRow(result.rows[0]);
}

async function updateActivitySettings(userId, action, sql, params) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, action);
    await client.query(sql, params);
    const saved = await loadActivitySettings(client);
    await client.query('COMMIT');
    return saved;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function setSessionIdleDays(idleDays, userId) {
  const days = normalizeSessionIdleDays(idleDays);
  const saved = await updateActivitySettings(
    userId,
    'configure the session timeout',
    `UPDATE app_settings SET session_idle_days = $1, updated_at = NOW() WHERE id = 'app_settings'`,
    [days]
  );
  logger.info({ userId, sessionIdleDays: days }, '[SECURITY] Session idle timeout updated');
  return saved;
}

async function setAccessTimeSettings(settings, userId) {
  const next = normalizeAccessTimeSettings(settings);
  const saved = await updateActivitySettings(
    userId,
    'configure access time tracking',
    `UPDATE app_settings
        SET access_time_tracking = $1, access_time_window_minutes = $2, access_time_flush_seconds = $3,
            updated_at = NOW()
      WHERE id = 'app_settings'`,
    [next.accessTimeTracking, next.accessTimeWindowMinutes, next.accessTimeFlushSeconds]
  );
  logger.info({ userId, ...next }, 'Access time tracking settings updated');
  return saved;
}

export { loadActivitySettings, setSessionIdleDays, setAccessTimeSettings };
