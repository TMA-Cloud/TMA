/**
 * Rotate FILE_ENCRYPTION_KEY for S3-stored files (AES-GCM-HKDF-STREAMING).
 *
 * - Asks for the OLD FILE_ENCRYPTION_KEY via stdin.
 * - Uses the NEW FILE_ENCRYPTION_KEY from environment (.env must already be updated).
 * - Streams each object through decrypt(oldKey) -> encrypt(newKey) -> putStream(same key),
 *   both in the streaming wire format.
 *
 * IMPORTANT:
 * - Run with the app stopped or in maintenance mode.
 * - Ensure you have a full backup of your bucket or replication enabled.
 * - This rotates the master key. To migrate legacy single-blob objects to the
 *   streaming format, use scripts/migrate-to-streaming-encryption.js instead.
 *
 * Usage (from backend directory):
 *   node scripts/rotate-file-encryption-s3.js
 */

import '../config/env.js';

import { PassThrough } from 'stream';
import { pipeline } from 'stream/promises';

import storage from '../utils/storageDriver.js';
import { createByteCountStream, createDecryptStreamFromStream, createEncryptStream } from '../utils/fileEncryption.js';

import { runKeyRotation } from './rotateEncryptionKeys.js';

async function rotateOneS3Object(key, oldKey, newKey) {
  const source = await storage.getReadStream(key);
  const { stream: decryptStream } = await createDecryptStreamFromStream(source, oldKey);
  const { stream: counter, getByteCount } = createByteCountStream();

  const uploadStream = new PassThrough();
  const uploadPromise = storage.putStream(key, uploadStream);

  try {
    await pipeline(decryptStream, createEncryptStream(newKey), counter, uploadStream);
  } catch (err) {
    uploadStream.destroy(err);
    throw err;
  }

  await uploadPromise;
  return getByteCount();
}

runKeyRotation({
  title: 'S3 FILE_ENCRYPTION_KEY rotation',
  checkEnvironment: () =>
    storage.useS3() ? null : 'ERROR: STORAGE_DRIVER is not s3. This script is only for S3-backed storage.',
  confirmPrompt: count =>
    `This will re-encrypt ${count} S3 objects in-place.\n` +
    'Make sure you have a bucket backup/replication and that the OLD key is correct.\n' +
    'Type YES (in all caps) to continue:',
  itemNoun: 'objects',
  itemLabel: 'key',
  logPrefix: '[KeyRotationS3]',
  rotateOne: rotateOneS3Object,
}).catch(err => {
  console.error('Fatal error during S3 rotation:', err);
  process.exit(1);
});
