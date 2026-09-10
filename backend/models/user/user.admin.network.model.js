import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { normalizeKnownProxies } from '../../utils/knownProxies.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';

async function getKnownProxiesSettings() {
  const result = await pool.query('SELECT known_proxies FROM app_settings WHERE id = $1', ['app_settings']);
  return result.rows.length > 0 ? normalizeKnownProxies(result.rows[0].known_proxies || []) : [];
}

async function setKnownProxiesSettings(knownProxies, userId) {
  const normalized = normalizeKnownProxies(knownProxies);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure known proxies');
    await client.query('UPDATE app_settings SET known_proxies = $1, updated_at = NOW() WHERE id = $2', [
      normalized,
      'app_settings',
    ]);
    await client.query('COMMIT');
    logger.info({ userId, count: normalized.length }, '[SECURITY] Known proxies settings updated');
    return normalized;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { getKnownProxiesSettings, setKnownProxiesSettings };
