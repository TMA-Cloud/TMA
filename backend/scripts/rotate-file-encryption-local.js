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
import crypto from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import { resolveFilePath } from '../utils/filePath.js';
import storage from '../utils/storageDriver.js';
import { readEncryptionMetadata } from '../utils/fileEncryption.js';

import { runKeyRotation } from './rotateEncryptionKeys.js';

// AES-256-GCM parameters must match fileEncryption.js
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

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

runKeyRotation({
  title: 'Local FILE_ENCRYPTION_KEY rotation',
  checkEnvironment: () =>
    storage.useS3()
      ? 'ERROR: STORAGE_DRIVER is configured for S3. Use rotate-file-encryption-s3.js for S3 buckets, ' +
        'and run this local script only on deployments that store encrypted files on local disk.'
      : null,
  confirmPrompt: count =>
    `This will re-encrypt ${count} files on disk in-place.\n` +
    'Make sure you have a backup and that the OLD key is correct.\n' +
    'Type YES (in all caps) to continue:',
  itemNoun: 'files',
  itemLabel: 'path',
  logPrefix: '[KeyRotationLocal]',
  rotateOne: rotateOneLocalFile,
}).catch(err => {
  console.error('Fatal error during rotation:', err);
  process.exit(1);
});
