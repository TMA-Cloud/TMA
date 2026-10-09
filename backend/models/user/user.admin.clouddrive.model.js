import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { cacheKeys, deleteCache, DEFAULT_TTL, getCache, setCache } from '../../utils/cache.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';

/** Save-only unless the stored row says false, so an odd row never opens the drive up. */
async function getCloudDriveSaveOnly() {
  const cacheKey = cacheKeys.cloudDriveSaveOnly();
  const cached = await getCache(cacheKey);
  if (cached !== null) return cached;

  const result = await pool.query('SELECT cloud_drive_save_only FROM app_settings WHERE id = $1', ['app_settings']);
  const saveOnly = result.rows[0]?.cloud_drive_save_only !== false;
  await setCache(cacheKey, saveOnly, DEFAULT_TTL);
  return saveOnly;
}

async function setCloudDriveSaveOnly(saveOnly, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure the Cloud Drive mode');
    await client.query('UPDATE app_settings SET cloud_drive_save_only = $1, updated_at = NOW() WHERE id = $2', [
      saveOnly === true,
      'app_settings',
    ]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  await deleteCache(cacheKeys.cloudDriveSaveOnly());
  logger.info({ userId, saveOnly: saveOnly === true }, '[SECURITY] Cloud Drive save-only mode updated');
}

export { getCloudDriveSaveOnly, setCloudDriveSaveOnly };
