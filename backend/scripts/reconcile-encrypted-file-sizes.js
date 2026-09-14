/**
 * One-time metadata migration for the optimized encrypted-download path.
 *
 * New downloads derive the encrypted Content-Length directly from files.size,
 * which must therefore contain the exact plaintext byte length. This script
 * reads the real S3/R2 object length, verifies the latest streaming-format
 * header, derives the corresponding plaintext length, and repairs stale rows.
 * Object bytes are not rewritten.
 *
 * Run with the app and worker stopped or in maintenance mode:
 *   npm run migrate:sizes                         # dry run (default)
 *   npm run migrate:sizes -- --apply             # prompt, then update
 *   npm run migrate:sizes -- --apply --yes        # non-interactive update
 *   npm run migrate:sizes -- --concurrency 32     # tune object-store HEADs
 *
 * If a row is reported as legacy format, first run `npm run migrate:streaming`,
 * then run this script again. The migration is resumable and safe to re-run.
 */

import '../config/env.js';

import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';

import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { connectRedis, disconnectRedis } from '../config/redis.js';
import { cacheKeys, deleteCaches, invalidateAllFileCaches } from '../utils/cache.js';
import { ciphertextSizeToPlaintextSize, HEADER_LENGTH } from '../utils/fileEncryption.js';
import storage from '../utils/storageDriver.js';

import { isTransientError, withRetries } from './lib/rotation-resilience.js';

const DEFAULT_CONCURRENCY = 16;
const DB_PAGE_SIZE = 500;

function parsePositiveInteger(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { apply: false, yes: false, concurrency: DEFAULT_CONCURRENCY };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--yes') options.yes = true;
    else if (arg === '--concurrency') options.concurrency = parsePositiveInteger(argv[++i], arg);
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.yes && !options.apply) throw new Error('--yes may only be used with --apply');
  return options;
}

function printUsage() {
  console.log('Usage: npm run migrate:sizes -- [--apply] [--yes] [--concurrency N]');
  console.log('Without --apply, the script performs a read-only dry run.');
}

function askQuestion(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(`\x1b[33m${query}\x1b[0m\n> `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const onRetry =
  label =>
  (err, { attempt, retries, backoff }) =>
    logger.warn(
      `[SizeMigration] Transient error on ${label} (attempt ${attempt}/${retries}), retrying in ${backoff}ms: ${err?.message || err}`
    );

async function fetchPage(afterId) {
  const result = await pool.query(
    `SELECT id, path, size, user_id AS "userId"
       FROM files
      WHERE type = 'file' AND path IS NOT NULL AND id > $1
      ORDER BY id ASC
      LIMIT $2`,
    [afterId, DB_PAGE_SIZE]
  );
  return result.rows;
}

async function readFirstByte(key) {
  const stream = await storage.getReadStream(key, { start: 0, end: 0 });
  try {
    for await (const chunk of stream) {
      if (chunk.length > 0) return chunk[0];
    }
    return null;
  } finally {
    stream.destroy();
  }
}

async function inspectRow(row) {
  const stat = await withRetries(() => storage.statObject(row.path), {
    isTransient: isTransientError,
    onRetry: onRetry(`HEAD id=${row.id}`),
  });
  if (!stat) throw new Error('Storage object is missing');
  if (!Number.isSafeInteger(Number(stat.size)) || Number(stat.size) < 0) {
    throw new Error(`Object store returned an invalid size: ${stat.size}`);
  }

  const firstByte = await withRetries(() => readFirstByte(row.path), {
    isTransient: isTransientError,
    onRetry: onRetry(`format check id=${row.id}`),
  });
  if (firstByte !== HEADER_LENGTH) {
    throw new Error(
      `Object is not in the latest streaming format (header=${firstByte ?? 'empty'}); run migrate:streaming first`
    );
  }

  const plaintextSize = ciphertextSizeToPlaintextSize(Number(stat.size));
  const databaseSize = Number(row.size);
  return {
    ...row,
    databaseSize: Number.isSafeInteger(databaseSize) ? databaseSize : null,
    plaintextSize,
    ciphertextSize: Number(stat.size),
  };
}

async function updateRows(rows) {
  if (rows.length === 0) return [];
  const result = await pool.query(
    `UPDATE files AS f
        SET size = repaired.plaintext_size
       FROM unnest($1::text[], $2::bigint[], $3::text[])
            AS repaired(id, plaintext_size, expected_path)
      WHERE f.id = repaired.id
        AND f.path = repaired.expected_path
        AND f.size IS DISTINCT FROM repaired.plaintext_size
      RETURNING f.id, f.user_id AS "userId"`,
    [rows.map(row => row.id), rows.map(row => row.plaintextSize), rows.map(row => row.path)]
  );
  return result.rows;
}

async function invalidateUpdatedCaches(rows, affectedUsers) {
  if (rows.length === 0) return;
  await deleteCaches(rows.map(row => cacheKeys.file(row.id, row.userId)));
  for (const row of rows) affectedUsers.add(row.userId);
}

async function writeFailureManifest(failures) {
  if (failures.length === 0) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const manifestPath = path.resolve(process.cwd(), `size-migration-failures-${stamp}.json`);
  await fs.writeFile(manifestPath, JSON.stringify(failures, null, 2));
  return manifestPath;
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    printUsage();
    return;
  }

  console.log('=== Reconcile encrypted file sizes ===');
  console.log(`Mode: ${options.apply ? 'APPLY' : 'DRY RUN (no database writes)'}`);
  console.log(`Object inspection concurrency: ${options.concurrency}`);

  if (options.apply && !options.yes) {
    const answer = await askQuestion(
      'This will update files.size and the derived quota/folder counters. Ensure the app and worker are stopped. Type APPLY to continue:'
    );
    if (answer !== 'APPLY') {
      console.log('Confirmation not given. Aborting without changes.');
      return;
    }
  }

  if (options.apply) await connectRedis();

  let cursor = '';
  let scanned = 0;
  let matched = 0;
  let mismatched = 0;
  let updated = 0;
  const failures = [];
  const affectedUsers = new Set();

  for (;;) {
    const rows = await fetchPage(cursor);
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1].id;

    const inspected = new Array(rows.length);
    let next = 0;
    const worker = async () => {
      while (next < rows.length) {
        const index = next++;
        const row = rows[index];
        try {
          inspected[index] = await inspectRow(row);
        } catch (error) {
          failures.push({ id: row.id, path: row.path, error: String(error?.message || error) });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(options.concurrency, rows.length) }, () => worker()));

    const valid = inspected.filter(Boolean);
    const repairs = valid.filter(row => row.databaseSize !== row.plaintextSize);
    scanned += rows.length;
    matched += valid.length - repairs.length;
    mismatched += repairs.length;

    if (options.apply && repairs.length > 0) {
      const changed = await updateRows(repairs);
      updated += changed.length;
      await invalidateUpdatedCaches(changed, affectedUsers);
      if (changed.length !== repairs.length) {
        const changedIds = new Set(changed.map(row => row.id));
        for (const row of repairs) {
          if (!changedIds.has(row.id)) {
            failures.push({ id: row.id, path: row.path, error: 'Row changed concurrently; not updated' });
          }
        }
      }
    }

    console.log(
      `Progress: scanned=${scanned} matched=${matched} mismatched=${mismatched} updated=${updated} failed=${failures.length}`
    );
  }

  if (options.apply) {
    for (const userId of affectedUsers) {
      await invalidateAllFileCaches(userId);
    }
  }

  const manifestPath = await writeFailureManifest(failures);
  console.log(
    `Done: scanned=${scanned}, matched=${matched}, mismatched=${mismatched}, updated=${updated}, failed=${failures.length}.`
  );
  if (!options.apply && mismatched > 0) {
    console.log('Dry run found rows to repair. Re-run with --apply after taking a database backup.');
  }
  if (manifestPath) {
    console.error(`Failure manifest: ${manifestPath}`);
    process.exitCode = 1;
  }
}

main()
  .catch(error => {
    console.error('Fatal size migration error:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([pool.end(), disconnectRedis()]);
  });
