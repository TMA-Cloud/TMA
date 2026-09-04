/**
 * Rotate the master key (KEK) for envelope-encrypted files — the cheap rotation.
 *
 * With envelope encryption each file body is encrypted under its own data key
 * (DEK); only the DEK is wrapped by the master KEK and stored on the row. So
 * rotating the KEK never reads, downloads, re-encrypts, or re-uploads a single
 * object and writes no temp files: it unwraps each ~60-byte DEK with the old
 * KEK, rewraps it with the new one in memory, and writes those bytes back with
 * an UPDATE. Object storage (S3/R2/rustFS/local) is never touched.
 *
 * Setup before running (rotate v1 -> v2 as the example):
 *   1. Generate the new key. Set it as the primary and bump the version:
 *        FILE_ENCRYPTION_KEY=<new key>
 *        FILE_KEK_VERSION=2
 *   2. Keep the OLD key available for unwrapping until this finishes:
 *        FILE_ENCRYPTION_KEY_V1=<old key>
 *   3. Run this script. Safe to interrupt and re-run — only rows still wrapped
 *      under an older version are touched, so a resumed run converges.
 *   4. Once "Remaining=0", you may drop FILE_ENCRYPTION_KEY_V1.
 *
 * Only files already converted to envelope form (a non-null wrapped DEK) are
 * rotated here. Pre-envelope files are keyed directly off the master key; run
 * scripts/backfill-envelope-encryption.js first to bring them under a DEK.
 *
 * Usage (from backend directory):
 *   node scripts/rotate-kek.js
 */

import '../config/env.js';

import readline from 'readline';
import fsPromises from 'fs/promises';
import path from 'path';

import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { primaryKekVersion, rewrapDekToPrimary } from '../utils/fileEncryption.js';

import { isTransientError, withRetries } from './lib/rotation-resilience.js';

const DB_PAGE_SIZE = 500;

// Rows that are enveloped but not yet wrapped under the current primary KEK.
const NEEDS_REWRAP_WHERE =
  "type = 'file' AND deleted_at IS NULL AND dek_wrapped IS NOT NULL AND dek_kek_version IS DISTINCT FROM $1";

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const yellow = '\x1b[33m';
    const reset = '\x1b[0m';
    rl.question(`${yellow}${query}${reset}\n> `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const dbRetry =
  label =>
  (err, { attempt, retries, backoff }) =>
    logger.warn(
      `[KekRotation] Transient DB error${label ? ` on ${label}` : ''} (attempt ${attempt}/${retries}), retrying in ${backoff}ms: ${err?.message || err}`
    );

async function countNeedingRewrap(primary) {
  const res = await pool.query(`SELECT COUNT(*)::bigint AS n FROM files WHERE ${NEEDS_REWRAP_WHERE}`, [primary]);
  return Number(res.rows[0].n);
}

/**
 * Fetch one keyset page of rows still wrapped under an old KEK, past `afterId`.
 * The cursor advances even over rows we fail to rewrap, so a bad row can never
 * wedge the loop.
 */
async function fetchPage(primary, afterId) {
  const res = await pool.query(
    `SELECT id, dek_wrapped AS "dekWrapped", dek_kek_version AS "dekKekVersion"
       FROM files
      WHERE ${NEEDS_REWRAP_WHERE} AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [primary, afterId, DB_PAGE_SIZE]
  );
  return res.rows;
}

/** Apply a page of rewraps in a single UPDATE ... FROM (unnest) statement. */
async function applyRewraps(updates) {
  if (!updates.length) return;
  const ids = updates.map(u => u.id);
  const wrapped = updates.map(u => u.dekWrapped);
  const versions = updates.map(u => u.kekVersion);
  await withRetries(
    () =>
      pool.query(
        `UPDATE files AS f
            SET dek_wrapped = v.dw, dek_kek_version = v.kv
           FROM (SELECT unnest($1::text[]) AS id, unnest($2::bytea[]) AS dw, unnest($3::int[]) AS kv) AS v
          WHERE f.id = v.id`,
        [ids, wrapped, versions]
      ),
    { isTransient: isTransientError, onRetry: dbRetry('batch update') }
  );
}

async function main() {
  console.log('=== KEK rotation (envelope files, metadata-only) ===');

  let primary;
  try {
    primary = primaryKekVersion();
  } catch (err) {
    console.error(err?.message || err);
    process.exit(1);
  }
  console.log(`Primary KEK version is ${primary}. Rewrapping every DEK wrapped under an older version.`);

  console.log('Connecting to database and counting rows to rotate...');
  const total = await countNeedingRewrap(primary);
  if (!total) {
    console.log('Nothing to rotate: every envelope file is already wrapped under the primary KEK.');
    await pool.end();
    return;
  }
  console.log(`Found ${total} file(s) wrapped under an older KEK version.`);

  const confirm = await askQuestion(
    `This will rewrap ${total} data key(s) to KEK version ${primary}. No objects are read or rewritten.\n` +
      'Ensure the OLD KEK(s) are set as FILE_ENCRYPTION_KEY_V<n> so their DEKs can be unwrapped.\n' +
      'Type YES (in all caps) to continue:'
  );
  if (confirm !== 'YES') {
    console.log('Confirmation not given. Aborting without making changes.');
    await pool.end();
    return;
  }

  let rewrapped = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];
  const maxErrorsToLog = total <= 20 ? total : 20;

  let cursor = '';
  for (;;) {
    const rows = await withRetries(() => fetchPage(primary, cursor), {
      isTransient: isTransientError,
      onRetry: dbRetry('fetch page'),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    const updates = [];
    for (const row of rows) {
      try {
        const next = rewrapDekToPrimary(row.dekWrapped, row.dekKekVersion);
        if (next === null) {
          skipped += 1; // already primary (shouldn't match the filter, but be safe)
        } else {
          updates.push({ id: row.id, dekWrapped: next.dekWrapped, kekVersion: next.kekVersion });
        }
      } catch (err) {
        failed += 1;
        failures.push({ id: row.id, fromVersion: row.dekKekVersion, error: String(err?.message || err) });
        if (failed <= maxErrorsToLog) {
          logger.error(
            `[KekRotation] Failed to rewrap id=${row.id} (from v${row.dekKekVersion}):`,
            err?.message || err
          );
        } else if (failed === maxErrorsToLog + 1) {
          console.error(
            `[KekRotation] Too many failures (>${maxErrorsToLog}); further details suppressed (see manifest).`
          );
        }
      }
    }

    await applyRewraps(updates);
    rewrapped += updates.length;
    console.log(`Progress ${rewrapped + skipped + failed}/${total} (rewrapped=${rewrapped} failed=${failed}).`);
  }

  console.log(`Done. Rewrapped=${rewrapped}, Skipped=${skipped}, Failed=${failed}.`);
  const remaining = await countNeedingRewrap(primary);
  console.log(`Remaining wrapped under an older KEK: ${remaining}.`);
  if (remaining === 0) {
    console.log('Rotation complete — you may now remove the old FILE_ENCRYPTION_KEY_V<n> value(s).');
  }
  if (failures.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const manifestPath = path.resolve(process.cwd(), `kek-rotation-failures-${stamp}.json`);
    try {
      await fsPromises.writeFile(manifestPath, JSON.stringify(failures, null, 2));
      console.log(
        `Wrote ${failures.length} failure(s) to ${manifestPath}. Usually a missing FILE_ENCRYPTION_KEY_V<n>; fix and re-run.`
      );
    } catch (err) {
      console.error('Could not write failure manifest:', err?.message || err);
    }
  }
  await pool.end();
}

process.on('unhandledRejection', reason => {
  logger.error(`[KekRotation] Ignored unhandled rejection (run continues): ${reason?.message || reason}`);
});

main().catch(err => {
  console.error('Fatal error during KEK rotation:', err);
  process.exit(1);
});
