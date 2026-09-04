/**
 * Per-file key resolution for envelope encryption.
 *
 * The download and zip paths need the streaming ikm for a stored object but
 * only hold its storage key. This is the single place that maps a storage key
 * to its (wrapped) data key and resolves the ikm — pre-envelope objects (no
 * wrapped DEK) fall back to the master key. Centralising it means no read path
 * can accidentally decrypt with the wrong key.
 */

import pool from '../../config/db.js';
import { resolveIkm } from '../../utils/fileEncryption.js';

/**
 * Fetch the wrapped-DEK columns for a stored object by its storage key/path.
 * @param {string} storagePath
 * @returns {Promise<{ dekWrapped: Buffer|null, dekKekVersion: number|null } | null>}
 */
async function getFileDekByPath(storagePath) {
  const res = await pool.query(
    'SELECT dek_wrapped AS "dekWrapped", dek_kek_version AS "dekKekVersion" FROM files WHERE path = $1 LIMIT 1',
    [storagePath]
  );
  return res.rows[0] || null;
}

/**
 * Resolve the streaming ikm for a stored object by its storage key/path.
 * @param {string} storagePath
 * @returns {Promise<Buffer>} 32-byte ikm (the unwrapped DEK, or the master key
 *   for pre-envelope objects)
 */
async function resolveIkmForPath(storagePath) {
  const row = await getFileDekByPath(storagePath);
  return resolveIkm(row || {});
}

export { getFileDekByPath, resolveIkmForPath };
