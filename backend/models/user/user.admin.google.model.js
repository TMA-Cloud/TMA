import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { primaryKekVersion } from '../../utils/fileEncryption.js';
import { decryptGoogleSecret, encryptGoogleSecret } from '../../utils/googleAuthSettings.js';
import { verifyFirstUser } from './user.admin.helpers.model.js';

const GOOGLE_COLUMNS = `google_client_id, google_client_secret_encrypted, google_client_secret_kek_version,
  google_redirect_uri, google_updated_at, google_config_version`;

class GoogleAuthConfigConflictError extends Error {
  constructor() {
    super('Google sign-in settings were changed by another session. Reload and try again.');
    this.name = 'GoogleAuthConfigConflictError';
    this.status = 409;
  }
}

async function readGoogleRow(db = pool, forUpdate = false) {
  const result = await db.query(
    `SELECT ${GOOGLE_COLUMNS} FROM app_settings WHERE id = 'app_settings'${forUpdate ? ' FOR UPDATE' : ''}`
  );
  return result.rows[0] || null;
}

/**
 * The active Google client with the secret decrypted, or null when Google
 * sign-in is not set up. Callers must keep the result in memory only.
 */
async function loadGoogleAuthConfig() {
  const row = await readGoogleRow();
  if (!row?.google_client_id) return null;
  return {
    clientId: row.google_client_id,
    clientSecret: decryptGoogleSecret(
      row.google_client_secret_encrypted,
      row.google_client_id,
      row.google_client_secret_kek_version
    ),
    redirectUri: row.google_redirect_uri,
    version: row.google_config_version,
  };
}

/** What the admin UI may see: everything except the secret. The client ID is public by design. */
async function getGoogleAuthSummary() {
  const row = await readGoogleRow();
  const base = { configured: false, version: row?.google_config_version ?? 0 };
  if (!row?.google_client_id) return base;
  return {
    ...base,
    configured: true,
    clientId: row.google_client_id,
    redirectUri: row.google_redirect_uri,
    updatedAt: row.google_updated_at,
  };
}

/**
 * Write the Google columns as a compare-and-swap on the config version, so two
 * admin tabs cannot overwrite each other unnoticed. `values` null clears them.
 */
async function writeGoogleConfig(values, userId, expectedVersion, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await verifyFirstUser(client, userId, action);
    const current = await readGoogleRow(client, true);
    if (expectedVersion != null && current.google_config_version !== expectedVersion) {
      throw new GoogleAuthConfigConflictError();
    }
    const sealed = values ? encryptGoogleSecret(values.clientSecret, values.clientId) : null;
    const result = await client.query(
      `UPDATE app_settings SET
         google_client_id = $1, google_client_secret_encrypted = $2, google_client_secret_kek_version = $3,
         google_redirect_uri = $4, google_updated_at = NOW(),
         google_config_version = google_config_version + 1, updated_at = NOW()
       WHERE id = 'app_settings'
       RETURNING google_config_version`,
      [values?.clientId ?? null, sealed?.encrypted ?? null, sealed?.kekVersion ?? null, values?.redirectUri ?? null]
    );
    await client.query('COMMIT');
    return result.rows[0].google_config_version;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function saveGoogleAuthConfig(config, userId, expectedVersion) {
  const version = await writeGoogleConfig(config, userId, expectedVersion, 'configure Google sign-in');
  logger.info({ userId, version }, '[SECURITY] Google sign-in settings updated by first user');
  return version;
}

async function clearGoogleAuthConfig(userId, expectedVersion) {
  const version = await writeGoogleConfig(null, userId, expectedVersion, 'configure Google sign-in');
  logger.info({ userId, version }, '[SECURITY] Google sign-in turned off by first user');
  return version;
}

/**
 * Rewrap the stored client secret under the primary KEK, as part of a KEK rotation.
 * @returns {Promise<boolean>} true when a rewrap was written
 */
async function rewrapGoogleSecret() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = await readGoogleRow(client, true);
    if (!row?.google_client_id || row.google_client_secret_kek_version === primaryKekVersion()) {
      await client.query('ROLLBACK');
      return false;
    }
    const secret = decryptGoogleSecret(
      row.google_client_secret_encrypted,
      row.google_client_id,
      row.google_client_secret_kek_version
    );
    const { encrypted, kekVersion } = encryptGoogleSecret(secret, row.google_client_id);
    // The version is left alone: the plaintext config is unchanged, so clients need no rebuild.
    await client.query(
      `UPDATE app_settings SET google_client_secret_encrypted = $1, google_client_secret_kek_version = $2
        WHERE id = 'app_settings'`,
      [encrypted, kekVersion]
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

export { loadGoogleAuthConfig, getGoogleAuthSummary, saveGoogleAuthConfig, clearGoogleAuthConfig, rewrapGoogleSecret };
