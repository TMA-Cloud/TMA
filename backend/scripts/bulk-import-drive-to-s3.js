/**
 * Bulk import a local drive (folder tree) into the app's S3 bucket with:
 * - Full folder hierarchy recreated in the DB (files table)
 * - Each file encrypted with FILE_ENCRYPTION_KEY and uploaded to S3
 * - File rows inserted so the app and DB stay in sync (no mismatch)
 *
 * Use this when you have existing data on disk (e.g. 100GB+) that you want
 * to move into the app without copying raw files to S3 (which would skip
 * encryption and DB records).
 *
 * The scan, preflight, folder creation and rollback all live in
 * bulkImportDrive.js; this file only supplies the S3 write.
 *
 * Prerequisites:
 * - STORAGE_DRIVER=s3 and S3 env vars (RUSTFS_* or AWS_*) set in .env
 * - FILE_ENCRYPTION_KEY set in .env (same key the app uses for decrypt)
 * - Database and (optionally) Redis running
 *
 * Usage (from backend directory):
 *   node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-id "YOUR_USER_ID"
 *   node scripts/bulk-import-drive-to-s3.js --source-dir "D:\MyDrive" --user-email "you@example.com"
 *
 * Options:
 *   --source-dir   (required) Root folder on disk to import
 *   --user-id      User ID in the app (owner of the imported files)
 *   --user-email   Alternatively, user email to resolve to user ID
 *   --concurrency  Max concurrent file uploads (default 2)
 *   --dry-run      Only list what would be imported; do not upload or insert
 *
 * Always enforces: per-user storage limit and admin-configured max file size (checked before any upload).
 * Preserves file and folder modification times (mtime) from the source drive.
 */

import '../config/env.js';

import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';

import mime from 'mime-types';

import { createByteCountStream, createEncryptStream } from '../utils/fileEncryption.js';
import { generateId } from '../utils/id.js';
import storage from '../utils/storageDriver.js';

import { runBulkImport } from './bulkImportDrive.js';

async function uploadOneFile(filePath, name, dryRun, modified = null) {
  const id = generateId(16);
  const ext = path.extname(name);
  const storageName = id + ext;
  const mimeType = mime.lookup(name) || 'application/octet-stream';

  if (dryRun) {
    const stat = await fs.stat(filePath);
    return { id, storageName, name, size: stat.size, mimeType };
  }

  const byteCount = createByteCountStream();
  const encryptStream = createEncryptStream();
  const readStream = createReadStream(filePath);

  readStream.on('error', () => {});
  byteCount.stream.on('error', () => {});
  encryptStream.on('error', () => {});

  // Count before encrypting so the recorded size is the plaintext size,
  // matching what the app's own upload path stores.
  readStream.pipe(byteCount.stream).pipe(encryptStream);

  try {
    await storage.putStream(storageName, encryptStream);
  } catch (err) {
    readStream.destroy();
    throw err;
  }

  const size = byteCount.getByteCount();

  return { id, storageName, name, size, mimeType, modified };
}

runBulkImport({
  scriptName: 'scripts/bulk-import-drive-to-s3.js',
  checkStorageDriver: () =>
    storage.useS3() ? null : 'STORAGE_DRIVER must be s3. Set STORAGE_DRIVER=s3 and RUSTFS_* (or AWS_*) in .env.',
  writeVerb: 'upload',
  writeVerbIng: 'Uploading',
  storeOneFile: uploadOneFile,
}).catch(err => {
  console.error(err);
  process.exit(1);
});
