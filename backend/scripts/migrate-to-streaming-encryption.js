/**
 * One-time migration: convert legacy single-blob objects to the
 * AES-GCM-HKDF-STREAMING format.
 *
 *   legacy: [IV(16)][AES-256-GCM ciphertext][TAG(16)]
 *   new:    header(40) || segment_0 || segment_1 ...  (Tink AES256_GCM_HKDF_1MB)
 *
 * Same FILE_ENCRYPTION_KEY for both (no key change, only a re-wrap). Auto-detects
 * the storage driver; safe to re-run (already-streaming objects are skipped).
 *
 * Run ONCE with the app stopped, and take a backup first. Usage:
 *   node scripts/migrate-to-streaming-encryption.js
 */

import '../config/env.js';

import crypto from 'crypto';
import readline from 'readline';
import { createReadStream, createWriteStream } from 'fs';
import fsPromises from 'fs/promises';
import { PassThrough, Transform } from 'stream';
import { pipeline } from 'stream/promises';

import pool from '../config/db.js';
import { logger } from '../config/logger.js';
import { resolveFilePath } from '../utils/filePath.js';
import storage from '../utils/storageDriver.js';
import {
  createByteCountStream,
  createDecryptStreamFromStream,
  createEncryptStream,
  getEncryptionKey,
  HEADER_LENGTH,
} from '../utils/fileEncryption.js';

// Legacy single-blob parameters (kept here so the app can drop them entirely).
const LEGACY_ALGORITHM = 'aes-256-gcm';
const LEGACY_IV_LENGTH = 16;
const LEGACY_TAG_LENGTH = 16;

const DEFAULT_CONCURRENCY = 10;
const DEFAULT_RETRIES = 5;

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/** Transient network/S3 hiccups worth retrying rather than failing the object. */
function isTransientError(err) {
  const code = err?.code || err?.Code || err?.name || '';
  const msg = (err?.message || '').toLowerCase();
  const status = err?.$metadata?.httpStatusCode;
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return (
    msg.includes('aborted') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('throttl') ||
    msg.includes('slowdown')
  );
}

/** Run `fn` with exponential backoff on transient errors. */
async function withRetries(fn, { retries = DEFAULT_RETRIES, label = '' } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isTransientError(err)) throw err;
      const backoff = Math.min(30000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      logger.warn(
        `[Migration] Transient error${label ? ` on ${label}` : ''} (attempt ${attempt}/${retries}), retrying in ${backoff}ms: ${err?.message || err}`
      );
      await sleep(backoff);
    }
  }
}

/**
 * Streaming decrypt of a legacy [IV][ciphertext][TAG] blob. Self-contained so it
 * survives the removal of the old code path from the app.
 */
function createLegacyDecryptTransform(key) {
  let ivRead = false;
  let head = Buffer.alloc(0);
  let tail = Buffer.alloc(0);
  let decipher = null;

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!ivRead) {
          head = Buffer.concat([head, chunk]);
          if (head.length < LEGACY_IV_LENGTH) return callback();
          const iv = head.subarray(0, LEGACY_IV_LENGTH);
          tail = head.subarray(LEGACY_IV_LENGTH);
          decipher = crypto.createDecipheriv(LEGACY_ALGORITHM, key, iv);
          ivRead = true;
          head = null;
        } else {
          tail = Buffer.concat([tail, chunk]);
        }
        // Hold back the trailing tag; everything before it is ciphertext.
        if (tail.length > LEGACY_TAG_LENGTH) {
          const body = tail.subarray(0, tail.length - LEGACY_TAG_LENGTH);
          tail = tail.subarray(tail.length - LEGACY_TAG_LENGTH);
          const out = decipher.update(body);
          if (out.length) this.push(out);
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (!ivRead || tail.length < LEGACY_TAG_LENGTH) {
          return callback(new Error('Invalid legacy object: shorter than IV + tag'));
        }
        decipher.setAuthTag(tail.subarray(tail.length - LEGACY_TAG_LENGTH));
        const out = decipher.final();
        if (out.length) this.push(out);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/** Drain a readable to completion, discarding its output. */
function drain(stream) {
  return new Promise((resolve, reject) => {
    stream.on('data', () => {});
    stream.on('end', resolve);
    stream.on('error', reject);
  });
}

/** Read the first byte of an object without downloading the rest. */
async function readFirstByte(key) {
  const stream = await storage.getReadStream(key, { start: 0, end: 0 });
  try {
    for await (const chunk of stream) {
      if (chunk.length > 0) return chunk[0];
    }
  } finally {
    stream.destroy();
  }
  return null;
}

/**
 * Whether an object is already in the streaming format. Peeks the header byte
 * first (cheap) and only then fully verifies by decrypting.
 */
async function isAlreadyStreaming(key, masterKey) {
  const firstByte = await readFirstByte(key);
  if (firstByte !== HEADER_LENGTH) return false;
  let src;
  try {
    src = await storage.getReadStream(key);
    const { stream } = await createDecryptStreamFromStream(src, masterKey);
    await drain(stream);
    return true;
  } catch {
    return false;
  } finally {
    if (src) src.destroy();
  }
}

/** Convert one legacy object stored on local disk, in place. */
async function convertLocal(storagePath, masterKey) {
  const absPath = resolveFilePath(storagePath);
  const tempPath = absPath + '.streaming';
  const { stream: counter, getByteCount } = createByteCountStream();

  try {
    await pipeline(
      createReadStream(absPath),
      createLegacyDecryptTransform(masterKey),
      createEncryptStream(masterKey),
      counter,
      createWriteStream(tempPath)
    );
  } catch (err) {
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  await fsPromises.unlink(absPath);
  await fsPromises.rename(tempPath, absPath);
  return getByteCount();
}

/** Convert one legacy object stored in S3, overwriting the same key. */
async function convertS3(key, masterKey) {
  const src = await storage.getReadStream(key);
  const { stream: counter, getByteCount } = createByteCountStream();
  const uploadStream = new PassThrough();
  const uploadPromise = storage.putStream(key, uploadStream);
  // Handle up-front so a rejected upload can't become an unhandled rejection.
  const uploadSettled = uploadPromise.catch(err => err);

  try {
    await pipeline(src, createLegacyDecryptTransform(masterKey), createEncryptStream(masterKey), counter, uploadStream);
    await uploadPromise;
  } catch (err) {
    src.destroy();
    uploadStream.destroy(err);
    await uploadSettled;
    throw err;
  }

  return getByteCount();
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

async function main() {
  console.log('=== Migrate encrypted files to AES-GCM-HKDF-STREAMING ===');

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('ERROR: FILE_ENCRYPTION_KEY must be set (the same key used to encrypt the existing files).');
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
  console.log('Connecting to database and fetching file list...');
  const res = await pool.query(
    "SELECT id, path FROM files WHERE type = 'file' AND deleted_at IS NULL AND path IS NOT NULL"
  );
  const rows = res.rows;
  if (!rows.length) {
    console.log('No files found to migrate. Nothing to do.');
    await pool.end();
    return;
  }
  console.log(`Found ${rows.length} files to consider.`);

  const confirm = await askQuestion(
    `This will re-wrap ${rows.length} ${usingS3 ? 'S3 objects' : 'files on disk'} in place.\n` +
      'Objects already in the streaming format are skipped automatically.\n' +
      'Make sure you have a backup and the app is stopped.\n' +
      'Type YES (in all caps) to continue:'
  );
  if (confirm !== 'YES') {
    console.log('Confirmation not given. Aborting without making changes.');
    await pool.end();
    return;
  }

  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  const total = rows.length;
  const concurrency = Math.max(1, Math.min(DEFAULT_CONCURRENCY, total));
  const logEvery = total <= 50 ? 1 : 50;
  const maxErrorsToLog = total <= 20 ? total : 20;
  console.log(`Starting migration with concurrency=${concurrency} (total: ${total})`);

  let index = 0;
  async function worker() {
    while (index < total) {
      const current = index++;
      const row = rows[current];
      if (!row) break;
      const key = row.path;
      try {
        if (await withRetries(() => isAlreadyStreaming(key, masterKey), { label: `check id=${row.id}` })) {
          skipped += 1;
        } else {
          const startedAt = Date.now();
          const bytes = await withRetries(() => (usingS3 ? convertS3(key, masterKey) : convertLocal(key, masterKey)), {
            label: `id=${row.id}`,
          });
          migrated += 1;
          const elapsed = Date.now() - startedAt;
          if (migrated % logEvery === 0) {
            console.log(
              `Progress: migrated=${migrated} skipped=${skipped} failed=${failed} (last id=${row.id}, bytes=${bytes}, ${elapsed}ms)`
            );
          }
        }
      } catch (err) {
        failed += 1;
        if (failed <= maxErrorsToLog) {
          logger.error(`[Migration] Failed on id=${row.id}, path=${key}:`, err?.message || err);
        } else if (failed === maxErrorsToLog + 1) {
          console.error(`[Migration] Too many failures (>${maxErrorsToLog}). Further details suppressed.`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`Done. Migrated=${migrated}, Skipped(already streaming)=${skipped}, Failed=${failed}.`);
  if (failed > 0) {
    console.log('Some objects failed. They were left untouched — fix the cause and re-run (safe to resume).');
  }
  await pool.end();
}

// Safety net: a stray rejection must never abort a run over tens of thousands of
// objects. Each object is rewritten atomically, so anything interrupted is left
// legacy and picked up on the next run.
process.on('unhandledRejection', reason => {
  logger.error(`[Migration] Ignored unhandled rejection (run continues): ${reason?.message || reason}`);
});

main().catch(err => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});
