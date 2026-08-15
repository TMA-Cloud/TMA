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
import { pipeline } from 'stream/promises';
import { Transform, PassThrough } from 'stream';

import storage from '../utils/storageDriver.js';
import { createByteCountStream, createTagBufferedDecipherTransform } from '../utils/fileEncryption.js';

import { runKeyRotation } from './rotateEncryptionKeys.js';

// AES-256-GCM parameters must match fileEncryption.js
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

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
  const bufferTagTransform = createTagBufferedDecipherTransform(decipher);

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
