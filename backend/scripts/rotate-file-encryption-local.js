/**
 * Rotate FILE_ENCRYPTION_KEY for locally stored files (AES-GCM-HKDF-STREAMING).
 *
 * - Asks for the OLD FILE_ENCRYPTION_KEY via stdin (no echo masking).
 * - Uses the NEW FILE_ENCRYPTION_KEY from environment (.env must already be updated).
 * - Re-encrypts each file on disk in-place: decrypt(oldKey) -> encrypt(newKey),
 *   both in the streaming wire format, keeping at most one temp copy per file.
 *
 * IMPORTANT:
 * - Run with the app stopped or in maintenance mode so no files are written concurrently.
 * - Ensure you have a full backup before running this on production data.
 * - This rotates the master key. To migrate legacy single-blob objects to the
 *   streaming format, use scripts/migrate-to-streaming-encryption.js instead.
 *
 * Usage (from backend directory):
 *   node scripts/rotate-file-encryption-local.js
 */

import '../config/env.js';

import { createReadStream, createWriteStream } from 'fs';
import fsPromises from 'fs/promises';
import { pipeline } from 'stream/promises';

import { resolveFilePath } from '../utils/filePath.js';
import storage from '../utils/storageDriver.js';
import { createByteCountStream, createDecryptStreamFromStream, createEncryptStream } from '../utils/fileEncryption.js';

import { runKeyRotation } from './rotateEncryptionKeys.js';

async function rotateOneLocalFile(storagePath, oldKey, newKey) {
  const absPath = resolveFilePath(storagePath);
  const tempPath = absPath + '.rotating';

  const { stream: decryptStream } = await createDecryptStreamFromStream(createReadStream(absPath), oldKey);
  const { stream: counter, getByteCount } = createByteCountStream();

  try {
    await pipeline(decryptStream, createEncryptStream(newKey), counter, createWriteStream(tempPath));
  } catch (err) {
    try {
      await fsPromises.unlink(tempPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  // Replace original without keeping two full copies.
  await fsPromises.unlink(absPath);
  await fsPromises.rename(tempPath, absPath);
  return getByteCount();
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
