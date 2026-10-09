import pool from '../config/db.js';

// Trashed files are included: restoring one later needs its key to still open.
const NEEDS_REWRAP = 'dek_wrapped IS NOT NULL AND dek_kek_version IS DISTINCT FROM $1';

/**
 * One keyset page of files whose data key is wrapped under another key version.
 * @returns {Promise<Array<{ id: string, dekWrapped: Buffer, dekKekVersion: number }>>}
 */
async function fetchRewrapPage(primary, afterId, limit) {
  const result = await pool.query(
    `SELECT id, dek_wrapped AS "dekWrapped", dek_kek_version AS "dekKekVersion"
       FROM files
      WHERE ${NEEDS_REWRAP} AND id > $2
      ORDER BY id
      LIMIT $3`,
    [primary, afterId, limit]
  );
  return result.rows;
}

/**
 * Write a page of rewrapped keys in one statement. A row is only updated while
 * it still has the version it was read with, so two runs at once cannot clash.
 * @param {Array<{ id: string, dekWrapped: Buffer, kekVersion: number, fromVersion: number }>} updates
 * @returns {Promise<number>} rows written
 */
async function applyRewraps(updates) {
  if (!updates.length) return 0;
  const result = await pool.query(
    `UPDATE files AS f
        SET dek_wrapped = v.dw, dek_kek_version = v.kv
       FROM (SELECT unnest($1::text[]) AS id, unnest($2::bytea[]) AS dw,
                    unnest($3::int[]) AS kv, unnest($4::int[]) AS old) AS v
      WHERE f.id = v.id AND f.dek_kek_version = v.old`,
    [
      updates.map(u => u.id),
      updates.map(u => u.dekWrapped),
      updates.map(u => u.kekVersion),
      updates.map(u => u.fromVersion),
    ]
  );
  return result.rowCount;
}

/**
 * How many file keys each key version wraps, and the versions of the bucket and Google secrets.
 * @returns {Promise<{ files: Map<number, number>, storageSecretVersion: number | null,
 *   googleSecretVersion: number | null }>}
 */
async function countKeysByVersion() {
  const [files, settings] = await Promise.all([
    pool.query(
      `SELECT dek_kek_version AS version, COUNT(*)::bigint AS n
         FROM files WHERE dek_wrapped IS NOT NULL
        GROUP BY dek_kek_version ORDER BY dek_kek_version`
    ),
    pool.query(
      `SELECT CASE WHEN storage_secret_encrypted IS NOT NULL THEN storage_secret_kek_version END AS storage,
              CASE WHEN google_client_secret_encrypted IS NOT NULL THEN google_client_secret_kek_version END AS google
         FROM app_settings WHERE id = 'app_settings'`
    ),
  ]);
  return {
    files: new Map(files.rows.map(row => [row.version, Number(row.n)])),
    storageSecretVersion: settings.rows[0]?.storage ?? null,
    googleSecretVersion: settings.rows[0]?.google ?? null,
  };
}

export { fetchRewrapPage, applyRewraps, countKeysByVersion };
