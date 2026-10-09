import pool from '../config/db.js';

async function getKekChecks() {
  const result = await pool.query('SELECT version, check_value FROM kek_checks');
  return new Map(result.rows.map(row => [row.version, row.check_value]));
}

/**
 * Record a version's check value unless another process got there first.
 * @returns {Promise<Buffer>} the value now stored, which may be the other process's
 */
async function recordKekCheck(version, checkValue) {
  await pool.query('INSERT INTO kek_checks (version, check_value) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [
    version,
    checkValue,
  ]);
  const result = await pool.query('SELECT check_value FROM kek_checks WHERE version = $1', [version]);
  return result.rows[0].check_value;
}

/** Something already sealed under a version, to prove a key against before first recording it. */
async function sampleSealedUnderVersion(version) {
  const [file, settings] = await Promise.all([
    pool.query('SELECT dek_wrapped FROM files WHERE dek_kek_version = $1 AND dek_wrapped IS NOT NULL LIMIT 1', [
      version,
    ]),
    pool.query(
      `SELECT storage_secret_encrypted, storage_access_key_id FROM app_settings
        WHERE id = 'app_settings' AND storage_secret_kek_version = $1`,
      [version]
    ),
  ]);
  return {
    dekWrapped: file.rows[0]?.dek_wrapped ?? null,
    storageSecret: settings.rows[0]
      ? { encrypted: settings.rows[0].storage_secret_encrypted, accessKeyId: settings.rows[0].storage_access_key_id }
      : null,
  };
}

/** Every key version that stored file keys or the bucket secret are wrapped under. */
async function kekVersionsInUse() {
  const result = await pool.query(
    `SELECT DISTINCT dek_kek_version AS version FROM files WHERE dek_wrapped IS NOT NULL
     UNION
     SELECT storage_secret_kek_version FROM app_settings
      WHERE id = 'app_settings' AND storage_secret_encrypted IS NOT NULL
     ORDER BY 1`
  );
  return result.rows.map(row => row.version).filter(version => version != null);
}

export { getKekChecks, recordKekCheck, sampleSealedUnderVersion, kekVersionsInUse };
