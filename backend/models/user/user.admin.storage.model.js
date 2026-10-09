import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { primaryKekVersion } from '../../utils/fileEncryption.js';
import { decryptStorageSecret, encryptStorageSecret, maskAccessKeyId } from '../../utils/storageSettings.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';

const STORAGE_COLUMNS = `storage_provider, storage_endpoint, storage_region, storage_bucket,
  storage_force_path_style, storage_access_key_id, storage_secret_encrypted,
  storage_secret_kek_version, storage_updated_at, storage_config_version`;

class StorageConfigConflictError extends Error {
  constructor() {
    super('Storage settings were changed by another session. Reload and try again.');
    this.name = 'StorageConfigConflictError';
    this.status = 409;
  }
}

async function readStorageRow(db = pool, forUpdate = false) {
  const result = await db.query(
    `SELECT ${STORAGE_COLUMNS} FROM app_settings WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
    ['app_settings']
  );
  return result.rows[0] || null;
}

/**
 * The active storage configuration with the secret decrypted, or null when
 * nobody has set it up yet. Callers must keep the result in memory only.
 */
async function loadStorageConfig() {
  const row = await readStorageRow();
  if (!row?.storage_provider) return null;
  return {
    provider: row.storage_provider,
    endpoint: row.storage_endpoint,
    region: row.storage_region,
    bucket: row.storage_bucket,
    forcePathStyle: row.storage_force_path_style,
    accessKeyId: row.storage_access_key_id,
    secretAccessKey: decryptStorageSecret(
      row.storage_secret_encrypted,
      row.storage_access_key_id,
      row.storage_secret_kek_version
    ),
    version: row.storage_config_version,
  };
}

/** What the admin UI may see: everything except the secret, with the key ID masked. */
async function getStorageSettingsSummary() {
  const row = await readStorageRow();
  const base = { configured: false, version: row?.storage_config_version ?? 0 };
  if (!row?.storage_provider) return base;
  return {
    ...base,
    configured: true,
    provider: row.storage_provider,
    endpoint: row.storage_endpoint,
    region: row.storage_region,
    bucket: row.storage_bucket,
    forcePathStyle: row.storage_force_path_style,
    accessKeyIdMasked: maskAccessKeyId(row.storage_access_key_id),
    updatedAt: row.storage_updated_at,
  };
}

/**
 * Persist a validated configuration. `expectedVersion` makes the write a
 * compare-and-swap, so two admin tabs cannot overwrite each other unnoticed.
 */
async function saveStorageConfig(config, userId, expectedVersion) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, 'configure storage');
    const current = await readStorageRow(client, true);
    if (expectedVersion != null && current.storage_config_version !== expectedVersion) {
      throw new StorageConfigConflictError();
    }

    const { encrypted, kekVersion } = encryptStorageSecret(config.secretAccessKey, config.accessKeyId);
    const result = await client.query(
      `UPDATE app_settings SET
         storage_provider = $1, storage_endpoint = $2, storage_region = $3, storage_bucket = $4,
         storage_force_path_style = $5, storage_access_key_id = $6, storage_secret_encrypted = $7,
         storage_secret_kek_version = $8, storage_updated_at = NOW(),
         storage_config_version = storage_config_version + 1, updated_at = NOW()
       WHERE id = $9
       RETURNING storage_config_version`,
      [
        config.provider,
        config.endpoint,
        config.region,
        config.bucket,
        config.forcePathStyle,
        config.accessKeyId,
        encrypted,
        kekVersion,
        'app_settings',
      ]
    );
    await client.query('COMMIT');
    const version = result.rows[0].storage_config_version;
    logger.info({ userId, version }, '[SECURITY] Storage settings updated by first user');
    return version;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Recent object keys, used to prove a new target still holds the existing files. */
async function getStorageSampleKeys(limit = 5) {
  const result = await pool.query(
    `SELECT path FROM files WHERE type = 'file' AND path IS NOT NULL ORDER BY created_at DESC NULLS LAST LIMIT $1`,
    [limit]
  );
  return result.rows.map(row => row.path);
}

/**
 * Rewrap the stored secret under the primary KEK, as part of a KEK rotation.
 * @returns {Promise<boolean>} true when a rewrap was written
 */
async function rewrapStorageSecret() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await readStorageRow(client, true);
    const primary = primaryKekVersion();
    if (!row?.storage_provider || row.storage_secret_kek_version === primary) {
      await client.query('ROLLBACK');
      return false;
    }
    const secret = decryptStorageSecret(
      row.storage_secret_encrypted,
      row.storage_access_key_id,
      row.storage_secret_kek_version
    );
    const { encrypted, kekVersion } = encryptStorageSecret(secret, row.storage_access_key_id);
    // The version is left alone: the plaintext config is unchanged, so clients need no rebuild.
    await client.query(
      'UPDATE app_settings SET storage_secret_encrypted = $1, storage_secret_kek_version = $2 WHERE id = $3',
      [encrypted, kekVersion, 'app_settings']
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export { loadStorageConfig, getStorageSettingsSummary, saveStorageConfig, getStorageSampleKeys, rewrapStorageSecret };
