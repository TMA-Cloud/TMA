/**
 * Shared driver for the FILE_ENCRYPTION_KEY rotation scripts.
 *
 * Rotation is the same procedure regardless of where the bytes live: confirm the
 * environment, read the active file rows, collect the old key, derive both keys,
 * then re-encrypt every object through a bounded worker pool. Only the per-object
 * rewrite differs between local disk and S3.
 */

import readline from 'readline';

import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { getEncryptionKey } from '../utils/fileEncryption.js';

const DEFAULT_CONCURRENCY = 10;

/**
 * Prompt on stdin and resolve with the trimmed answer.
 * The prompt is coloured bright yellow so it stands out from the surrounding logs.
 */
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    const yellow = '\x1b[33m';
    const reset = '\x1b[0m';
    rl.question(`${yellow}${query}${reset}\n> `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Run a raw key through the app's own key derivation by swapping it into the
 * environment that getEncryptionKey() reads, then restoring the previous value.
 */
function deriveKeyFromRaw(raw) {
  const prev = process.env.FILE_ENCRYPTION_KEY;
  process.env.FILE_ENCRYPTION_KEY = raw;
  try {
    return getEncryptionKey();
  } finally {
    process.env.FILE_ENCRYPTION_KEY = prev;
  }
}

/**
 * @param {object} options
 * @param {string} options.title            Banner printed at startup.
 * @param {() => string | null} options.checkEnvironment  Returns an error message when the
 *   configured storage driver does not match this script, or null when it is safe to run.
 * @param {(count: number) => string} options.confirmPrompt  Confirmation text shown before any write.
 * @param {string} options.itemNoun         Plural noun for progress output ('files', 'objects').
 * @param {string} options.itemLabel        Per-row label for progress output ('path', 'key').
 * @param {string} options.logPrefix        Prefix used on failure logs.
 * @param {(path: string, oldKey: Buffer, newKey: Buffer) => Promise<number>} options.rotateOne
 *   Re-encrypts a single stored object in place and resolves with the bytes rotated.
 */
async function runKeyRotation({ title, checkEnvironment, confirmPrompt, itemNoun, itemLabel, logPrefix, rotateOne }) {
  console.log(`=== ${title} ===`);

  const environmentError = checkEnvironment();
  if (environmentError) {
    console.error(environmentError);
    process.exit(1);
  }

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('ERROR: New FILE_ENCRYPTION_KEY must be set in environment before running this script.');
    process.exit(1);
  }

  // Trigger the DB connection (and its logging) BEFORE asking for input,
  // so the prompt doesn't get interleaved with "Database connected" logs.
  console.log('Connecting to database and fetching file list...');
  const res = await pool.query(
    "SELECT id, path FROM files WHERE type = 'file' AND deleted_at IS NULL AND path IS NOT NULL"
  );
  const rows = res.rows;
  if (!rows.length) {
    console.log('No files found to rotate (files table has zero active file rows). Nothing to do.');
    await pool.end();
    return;
  }
  console.log(`Found ${rows.length} files to consider for rotation.`);

  const newKeyRaw = process.env.FILE_ENCRYPTION_KEY;
  const oldKeyRaw = await askQuestion('Enter OLD FILE_ENCRYPTION_KEY:');
  if (!oldKeyRaw) {
    console.error('No old key provided. Aborting.');
    await pool.end();
    process.exit(1);
  }

  const confirm = await askQuestion(confirmPrompt(rows.length));
  if (confirm !== 'YES') {
    console.log('Confirmation not given. Aborting without making changes.');
    await pool.end();
    return;
  }

  let oldKey;
  let newKey;
  try {
    oldKey = deriveKeyFromRaw(oldKeyRaw);
    newKey = deriveKeyFromRaw(newKeyRaw);
  } catch (err) {
    console.error('Failed to derive keys:', err?.message || err);
    await pool.end();
    process.exit(1);
  }

  let processed = 0;
  let failed = 0;

  const total = rows.length;
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, total));
  console.log(`Starting rotation with concurrency=${concurrency} (total ${itemNoun}: ${total})`);
  const logEvery = total <= 50 ? 1 : 50;
  const maxErrorsToLog = total <= 20 ? total : 20;

  let index = 0;
  async function worker() {
    while (index < total) {
      const current = index++;
      const row = rows[current];
      if (!row) break;
      const storagePath = row.path;
      try {
        const startedAt = Date.now();
        const bytesRotated = await rotateOne(storagePath, oldKey, newKey);
        const elapsedMs = Date.now() - startedAt;
        processed += 1;
        if (processed % logEvery === 0 || processed === total) {
          console.log(
            `Progress ${processed}/${total} (last: #${current + 1} id=${row.id} ${itemLabel}=${storagePath}, bytes=${bytesRotated}, ${elapsedMs}ms)`
          );
        }
      } catch (err) {
        failed += 1;
        if (failed <= maxErrorsToLog) {
          logger.error(
            `${logPrefix} Failed to rotate file id=${row.id}, ${itemLabel}=${storagePath}:`,
            err?.message || err
          );
        } else if (failed === maxErrorsToLog + 1) {
          console.error(
            `${logPrefix} Too many failures (>${maxErrorsToLog}). Further failure details will be suppressed.`
          );
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`Done. Processed=${processed}, Failed=${failed}.`);
  await pool.end();
}

export { runKeyRotation };
