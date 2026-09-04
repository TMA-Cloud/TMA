/**
 * One-time backfill: bring pre-envelope files under per-file data keys (DEKs).
 *
 * Files written before envelope encryption have their body keyed directly off
 * the master key (dek_wrapped IS NULL). This re-encrypts each such body under a
 * fresh DEK and records the wrapped DEK on the row, so that from then on the
 * master key can be rotated cheaply with scripts/rotate-kek.js (a metadata-only
 * UPDATE, no object I/O).
 *
 * Unlike KEK rotation, this must rewrite object bytes — a legacy body cannot be
 * re-keyed without re-encrypting it — so it is the expensive, run-once step. It
 * is crash-safe and resumable: each file is re-encrypted to a NEW storage key,
 * then the row is flipped to it in one UPDATE, then the old object is deleted.
 * A crash at any point leaves the row pointing at a readable object; already
 * converted rows (dek_wrapped set) are skipped, so a re-run only does the rest.
 *
 * Run with the app stopped or in maintenance mode, after applying migrations
 * and taking a backup. Usage (from backend directory):
 *   node scripts/backfill-envelope-encryption.js [--concurrency N]
 *
 * --concurrency sets how many objects are re-encrypted at once (default 8).
 * Each is a full download + re-encrypt + re-upload, so raise it for many small
 * files on a fast link (16–32), lower it if the store starts refusing connects.
 */

import '../config/env.js';

import readline from 'readline';
import { createReadStream, createWriteStream } from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';

import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { UPLOAD_DIR } from '../config/paths.js';
import { resolveFilePath } from '../utils/filePath.js';
import { generateId } from '../utils/id.js';
import storage from '../utils/storageDriver.js';
import {
  createDecryptStreamFromStream,
  createEncryptStream,
  getEncryptionKey,
  newWrappedDek,
} from '../utils/fileEncryption.js';

import { isTransientError, withRetries } from './lib/rotation-resilience.js';

const DEFAULT_CONCURRENCY = 8;
const DB_PAGE_SIZE = 500;

const NEEDS_BACKFILL_WHERE = "type = 'file' AND deleted_at IS NULL AND path IS NOT NULL AND dek_wrapped IS NULL";

/** Concurrency from `--concurrency N` (falls back to the default). */
function parseConcurrency() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--concurrency');
  if (i === -1 || !args[i + 1]) return DEFAULT_CONCURRENCY;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONCURRENCY;
}

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

const onRetry =
  label =>
  (err, { attempt, retries, backoff }) =>
    logger.warn(
      `[EnvelopeBackfill] Transient error${label ? ` on ${label}` : ''} (attempt ${attempt}/${retries}), retrying in ${backoff}ms: ${err?.message || err}`
    );

async function countNeedingBackfill() {
  const res = await pool.query(`SELECT COUNT(*)::bigint AS n FROM files WHERE ${NEEDS_BACKFILL_WHERE}`);
  return Number(res.rows[0].n);
}

async function fetchPage(afterId) {
  const res = await pool.query(
    `SELECT id, path FROM files WHERE ${NEEDS_BACKFILL_WHERE} AND id > $1 ORDER BY id ASC LIMIT $2`,
    [afterId, DB_PAGE_SIZE]
  );
  return res.rows;
}

/** Re-encrypt one S3 object under `dek` into a new key; returns nothing. */
async function rewriteS3(oldKey, newKey, masterKey, dek) {
  const source = await storage.getReadStream(oldKey);
  const { stream: decryptStream } = await createDecryptStreamFromStream(source, masterKey);
  const uploadStream = new PassThrough();
  const uploadPromise = storage.putStream(newKey, uploadStream);
  const uploadSettled = uploadPromise.catch(err => err);
  try {
    await pipeline(decryptStream, createEncryptStream(dek), uploadStream);
    await uploadPromise;
  } catch (err) {
    source.destroy();
    uploadStream.destroy(err);
    await uploadSettled;
    throw err;
  }
}

/** Re-encrypt one local file under `dek` into a new file; returns nothing. */
async function rewriteLocal(oldPath, newKey, masterKey, dek) {
  const absOld = resolveFilePath(oldPath);
  const absNew = path.join(UPLOAD_DIR, newKey);
  const { stream: decryptStream } = await createDecryptStreamFromStream(createReadStream(absOld), masterKey);
  await pipeline(decryptStream, createEncryptStream(dek), createWriteStream(absNew));
}

/**
 * Convert one file to envelope form: re-encrypt to a NEW key, flip the row, then
 * delete the old object. The UPDATE is guarded on dek_wrapped IS NULL so a
 * resumed run cannot double-apply.
 */
async function backfillOne(row, usingS3, masterKey) {
  const oldKey = row.path;
  const newKey = generateId(16) + path.extname(oldKey);
  const { dek, dekWrapped, kekVersion } = newWrappedDek();

  if (usingS3) {
    await rewriteS3(oldKey, newKey, masterKey, dek);
  } else {
    await rewriteLocal(oldKey, newKey, masterKey, dek);
  }

  const res = await pool.query(
    'UPDATE files SET path = $1, dek_wrapped = $2, dek_kek_version = $3 WHERE id = $4 AND dek_wrapped IS NULL',
    [newKey, dekWrapped, kekVersion, row.id]
  );

  // Commit landed: the row now points at the new object. Drop the leftovers.
  // If the guard matched nothing (a concurrent/previous run won), the new object
  // we just wrote is the orphan instead.
  const swapped = res.rowCount === 1;
  const orphan = swapped ? oldKey : newKey;
  if (usingS3) {
    await storage
      .deleteObject(orphan)
      .catch(err => logger.warn({ err, orphan }, '[EnvelopeBackfill] Orphan cleanup failed'));
  } else {
    await fsPromises.unlink(swapped ? resolveFilePath(oldKey) : path.join(UPLOAD_DIR, newKey)).catch(() => {});
  }
}

async function main() {
  console.log('=== Backfill: convert pre-envelope files to per-file DEKs ===');

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('ERROR: FILE_ENCRYPTION_KEY must be set (the master key the existing files are encrypted under).');
    process.exit(1);
  }
  let masterKey;
  try {
    masterKey = getEncryptionKey();
  } catch (err) {
    console.error('Failed to load FILE_ENCRYPTION_KEY:', err?.message || err);
    process.exit(1);
  }

  const usingS3 = storage.useS3();
  console.log(`Storage driver: ${usingS3 ? 's3' : 'local'}`);
  console.log('Connecting to database and counting files to convert...');
  const total = await countNeedingBackfill();
  if (!total) {
    console.log('Nothing to do: every file already has a wrapped DEK.');
    await pool.end();
    return;
  }
  console.log(`Found ${total} pre-envelope file(s) to convert.`);

  const confirm = await askQuestion(
    `This re-encrypts ${total} ${usingS3 ? 'S3 object(s)' : 'file(s)'} under fresh per-file keys, in place of the master key.\n` +
      'Each is rewritten to a new storage key and the old object deleted; safe to interrupt and re-run.\n' +
      'Make sure you have a backup and the app is stopped. Type YES (in all caps) to continue:'
  );
  if (confirm !== 'YES') {
    console.log('Confirmation not given. Aborting without making changes.');
    await pool.end();
    return;
  }

  let converted = 0;
  let failed = 0;
  const failures = [];
  const concurrency = Math.max(1, Math.min(parseConcurrency(), total));
  const maxErrorsToLog = total <= 20 ? total : 20;
  console.log(`Starting backfill with concurrency=${concurrency} (total: ${total}).`);

  let cursor = '';
  for (;;) {
    const rows = await withRetries(() => fetchPage(cursor), {
      isTransient: isTransientError,
      onRetry: onRetry('fetch page'),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;

    let index = 0;
    const worker = async () => {
      while (index < rows.length) {
        const row = rows[index++];
        if (!row) break;
        try {
          await withRetries(() => backfillOne(row, usingS3, masterKey), {
            isTransient: isTransientError,
            onRetry: onRetry(`id=${row.id}`),
          });
          converted += 1;
          if (converted % 50 === 0) {
            console.log(`Progress: converted=${converted} failed=${failed} (last id=${row.id}).`);
          }
        } catch (err) {
          failed += 1;
          failures.push({ id: row.id, path: row.path, error: String(err?.message || err) });
          if (failed <= maxErrorsToLog) {
            logger.error(`[EnvelopeBackfill] Failed on id=${row.id}, path=${row.path}:`, err?.message || err);
          } else if (failed === maxErrorsToLog + 1) {
            console.error(
              `[EnvelopeBackfill] Too many failures (>${maxErrorsToLog}); further details suppressed (see manifest).`
            );
          }
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
  }

  console.log(`Done. Converted=${converted}, Failed=${failed}.`);
  if (failures.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const manifestPath = path.resolve(process.cwd(), `envelope-backfill-failures-${stamp}.json`);
    try {
      await fsPromises.writeFile(manifestPath, JSON.stringify(failures, null, 2));
      console.log(`Wrote ${failures.length} failure(s) to ${manifestPath}. Fix the cause and re-run (safe to resume).`);
    } catch (err) {
      console.error('Could not write failure manifest:', err?.message || err);
    }
  }
  await pool.end();
}

process.on('unhandledRejection', reason => {
  logger.error(`[EnvelopeBackfill] Ignored unhandled rejection (run continues): ${reason?.message || reason}`);
});

main().catch(err => {
  console.error('Fatal error during envelope backfill:', err);
  process.exit(1);
});
