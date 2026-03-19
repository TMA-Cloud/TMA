/**
 * Rotate FILE_ENCRYPTION_KEY for S3-stored encrypted files.
 *
 * - Asks for OLD FILE_ENCRYPTION_KEY via stdin.
 * - Uses NEW FILE_ENCRYPTION_KEY from environment (.env must already be updated).
 * - Streams each object through decrypt(oldKey) -> encrypt(newKey) -> putStream(same key).
 *
 * IMPORTANT:
 * - Run with the app stopped or in maintenance mode.
 * - Ensure you have a full backup of your bucket or replication enabled.
 *
 * Usage (from backend directory):
 *   node scripts/rotate-file-encryption-s3.js
 */

import '../config/env.js';

import crypto from 'crypto';
import readline from 'readline';
import { pipeline } from 'stream/promises';
import { Transform, PassThrough } from 'stream';

import pool from '../config/db.js';
import storage from '../utils/storageDriver.js';
import { logger } from '../config/logger.js';
import { getEncryptionKey, createByteCountStream } from '../utils/fileEncryption.js';

// AES-256-GCM parameters must match fileEncryption.js
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const DEFAULT_CONCURRENCY = 10;

function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise(resolve => {
    // Color the question in bright yellow for visibility
    const yellow = '\x1b[33m';
    const reset = '\x1b[0m';
    rl.question(`${yellow}${query}${reset}\n> `, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

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
 * Create a transform that buffers the final TAG_LENGTH bytes at the end of the stream
 * and feeds them to decipher.setAuthTag before final().
 */
function createTagBufferedDecipherTransform(decipher, tagLength) {
  return new Transform({
    transform(chunk, encoding, callback) {
      this._tail = Buffer.concat([this._tail || Buffer.alloc(0), chunk]);
      while (this._tail.length > tagLength) {
        const out = this._tail.subarray(0, this._tail.length - tagLength);
        this._tail = this._tail.subarray(this._tail.length - tagLength);
        try {
          const dec = decipher.update(out);
          if (dec.length > 0) this.push(dec);
        } catch (err) {
          return callback(err);
        }
      }
      callback();
    },
    flush(callback) {
      try {
        decipher.setAuthTag(this._tail || Buffer.alloc(0));
        const final = decipher.final();
        if (final.length > 0) this.push(final);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

async function rotateOneS3Object(key, oldKey, newKey) {
  const sourceStream = await storage.getReadStream(key);

  // Read IV from the beginning
  const ivBuf = await new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    function onData(chunk) {
      chunks.push(chunk);
      total += chunk.length;
      if (total >= IV_LENGTH) {
        sourceStream.off('data', onData);
        sourceStream.pause();
        const buf = Buffer.concat(chunks);
        const iv = buf.subarray(0, IV_LENGTH);
        const rest = buf.subarray(IV_LENGTH);
        if (rest.length > 0) sourceStream.unshift(rest);
        resolve(iv);
      }
    }
    function onError(err) {
      sourceStream.off('data', onData);
      reject(err);
    }
    function onEnd() {
      reject(new Error('Encrypted object too small to contain IV'));
    }
    sourceStream.on('data', onData);
    sourceStream.once('error', onError);
    sourceStream.once('end', onEnd);
  });

  const decipher = crypto.createDecipheriv(ALGORITHM, oldKey, ivBuf);
  const tagLength = 16; // matches fileEncryption.js TAG_LENGTH
  const bufferTagTransform = createTagBufferedDecipherTransform(decipher, tagLength);

  const newIv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, newKey, newIv);

  const appendTagStream = new Transform({
    transform(chunk, enc, cb) {
      cb(null, chunk);
    },
    flush(cb) {
      this.push(cipher.getAuthTag());
      cb();
    },
  });

  const byteCounter = createByteCountStream();
  const uploadStream = new PassThrough();

  // Kick off upload
  const uploadPromise = storage.putStream(key, uploadStream);

  // First write new IV into upload stream
  uploadStream.write(newIv);

  try {
    await pipeline(sourceStream, bufferTagTransform, cipher, byteCounter.stream, appendTagStream, uploadStream);
  } catch (err) {
    // Ensure upload stream is closed on failure
    uploadStream.destroy(err);
    throw err;
  }

  await uploadPromise;
  return byteCounter.getByteCount();
}

async function main() {
  console.log('=== S3 FILE_ENCRYPTION_KEY rotation ===');

  if (!storage.useS3()) {
    console.error('ERROR: STORAGE_DRIVER is not s3. This script is only for S3-backed storage.');
    process.exit(1);
  }

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('ERROR: New FILE_ENCRYPTION_KEY must be set in environment before running this script.');
    process.exit(1);
  }

  // Trigger DB connection (and its logging) BEFORE asking for input,
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

  const confirm = await askQuestion(
    `This will re-encrypt ${rows.length} S3 objects in-place.\n` +
      'Make sure you have a bucket backup/replication and that the OLD key is correct.\n' +
      'Type YES (in all caps) to continue:'
  );
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
  console.log(`Starting rotation with concurrency=${concurrency} (total objects: ${total})`);
  const logEvery = total <= 50 ? 1 : 50;
  const maxErrorsToLog = total <= 20 ? total : 20;

  let index = 0;
  async function worker() {
    while (index < total) {
      const current = index++;
      const row = rows[current];
      if (!row) break;
      const key = row.path;
      try {
        const startedAt = Date.now();
        const bytesRotated = await rotateOneS3Object(key, oldKey, newKey);
        const elapsedMs = Date.now() - startedAt;
        processed += 1;
        if (processed % logEvery === 0 || processed === total) {
          console.log(
            `Progress ${processed}/${total} (last: #${current + 1} id=${row.id} key=${key}, bytes=${bytesRotated}, ${elapsedMs}ms)`
          );
        }
      } catch (err) {
        failed += 1;
        if (failed <= maxErrorsToLog) {
          logger.error(`[KeyRotationS3] Failed to rotate file id=${row.id}, key=${key}:`, err?.message || err);
        } else if (failed === maxErrorsToLog + 1) {
          console.error(
            `[KeyRotationS3] Too many failures (>${maxErrorsToLog}). Further failure details will be suppressed.`
          );
        }
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  console.log(`Done. Processed=${processed}, Failed=${failed}.`);
  await pool.end();
}

main().catch(err => {
  console.error('Fatal error during S3 rotation:', err);
  process.exit(1);
});
