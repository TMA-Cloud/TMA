/**
 * Rotate FILE_ENCRYPTION_KEY for locally stored encrypted files.
 *
 * - Asks for OLD FILE_ENCRYPTION_KEY via stdin (no echo masking).
 * - Uses NEW FILE_ENCRYPTION_KEY from environment (.env must already be updated).
 * - Re-encrypts each file on disk in-place (at most one extra temp copy per file at a time).
 *
 * IMPORTANT:
 * - Run with the app stopped or in maintenance mode so no files are being written concurrently.
 * - Ensure you have a full backup before running this on production data.
 *
 * Usage (from backend directory):
 *   node scripts/rotate-file-encryption-local.js
 */

import '../config/env.js';

import fs from 'fs';
import fsPromises from 'fs/promises';
import readline from 'readline';
import crypto from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import pool from '../config/db.js';
import { resolveFilePath } from '../utils/filePath.js';
import { logger } from '../config/logger.js';
import storage from '../utils/storageDriver.js';
import { getEncryptionKey, readEncryptionMetadata } from '../utils/fileEncryption.js';

// AES-256-GCM parameters must match fileEncryption.js
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const DEFAULT_CONCURRENCY = 10;

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

function deriveKeyFromRaw(raw) {
  const prev = process.env.FILE_ENCRYPTION_KEY;
  process.env.FILE_ENCRYPTION_KEY = raw;
  try {
    return getEncryptionKey();
  } finally {
    process.env.FILE_ENCRYPTION_KEY = prev;
  }
}

async function rotateOneLocalFile(storagePath, oldKey, newKey) {
  const absPath = resolveFilePath(storagePath);

  const { iv, tag, fileSize } = await readEncryptionMetadata(absPath);

  const decipher = crypto.createDecipheriv(ALGORITHM, oldKey, iv);
  decipher.setAuthTag(tag);

  const newIv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, newKey, newIv);

  const tempPath = absPath + '.rotating';

  // Stream only ciphertext portion
  const ciphertextEnd = fileSize - TAG_LENGTH - 1; // inclusive
  const input =
    ciphertextEnd >= IV_LENGTH
      ? fs.createReadStream(absPath, { start: IV_LENGTH, end: ciphertextEnd })
      : fs.createReadStream(absPath, { start: IV_LENGTH, end: IV_LENGTH - 1 });

  const output = fs.createWriteStream(tempPath);

  // Write new IV first
  output.write(newIv);

  // Append auth tag at end
  const appendTagStream = new Transform({
    transform(chunk, enc, cb) {
      cb(null, chunk);
    },
    flush(cb) {
      this.push(cipher.getAuthTag());
      cb();
    },
  });

  try {
    await pipeline(input, decipher, cipher, appendTagStream, output);
  } catch (err) {
    // Clean up temp on failure
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Replace original file without keeping two full copies:
  // first remove original, then rename temp to original name.
  await fsPromises.unlink(absPath);
  await fsPromises.rename(tempPath, absPath);
  return fileSize;
}

async function main() {
  console.log('=== Local FILE_ENCRYPTION_KEY rotation ===');

  if (storage.useS3()) {
    console.error(
      'ERROR: STORAGE_DRIVER is configured for S3. Use rotate-file-encryption-s3.js for S3 buckets, ' +
        'and run this local script only on deployments that store encrypted files on local disk.'
    );
    process.exit(1);
  }

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.error('ERROR: New FILE_ENCRYPTION_KEY must be set in environment before running this script.');
    process.exit(1);
  }

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
    `This will re-encrypt ${rows.length} files on disk in-place.\n` +
      'Make sure you have a backup and that the OLD key is correct.\n' +
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
  console.log(`Starting rotation with concurrency=${concurrency} (total files: ${total})`);
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
        const bytesRotated = await rotateOneLocalFile(storagePath, oldKey, newKey);
        const elapsedMs = Date.now() - startedAt;
        processed += 1;
        if (processed % logEvery === 0 || processed === total) {
          console.log(
            `Progress ${processed}/${total} (last: #${current + 1} id=${row.id} path=${storagePath}, bytes=${bytesRotated}, ${elapsedMs}ms)`
          );
        }
      } catch (err) {
        failed += 1;
        if (failed <= maxErrorsToLog) {
          logger.error(
            `[KeyRotationLocal] Failed to rotate file id=${row.id}, path=${storagePath}:`,
            err?.message || err
          );
        } else if (failed === maxErrorsToLog + 1) {
          console.error(
            `[KeyRotationLocal] Too many failures (>${maxErrorsToLog}). Further failure details will be suppressed.`
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
  console.error('Fatal error during rotation:', err);
  process.exit(1);
});
