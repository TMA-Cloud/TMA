/**
 * Bulk import a local drive (folder tree) into the app's local storage with:
 * - Full folder hierarchy recreated in the DB (files table)
 * - Each file encrypted with FILE_ENCRYPTION_KEY and stored locally
 * - File rows inserted so the app and DB stay in sync (no mismatch)
 *
 * Use this when you have existing data on disk (e.g. 100GB+) that you want
 * to move into the app without copying raw files to disk (which would skip
 * encryption and DB records).
 *
 * The scan, preflight, folder creation and rollback all live in
 * bulkImportDrive.js; this file only supplies the local-disk write.
 *
 * Prerequisites:
 * - STORAGE_DRIVER=local and LOCAL_STORAGE_PATH set in .env
 * - FILE_ENCRYPTION_KEY set in .env (same key the app uses for decrypt)
 * - Database and (optionally) Redis running
 * - Sufficient disk space for encrypted files
 *
 * Usage (from backend directory):
 *   node scripts/bulk-import-drive-to-local.js --source-dir "D:\MyDrive" --user-id "YOUR_USER_ID"
 *   node scripts/bulk-import-drive-to-local.js --source-dir "D:\MyDrive" --user-email "you@example.com"
 *
 * Options:
 *   --source-dir   (required) Root folder on disk to import
 *   --user-id      User ID in the app (owner of the imported files)
 *   --user-email   Alternatively, user email to resolve to user ID
 *   --concurrency  Max concurrent file copies (default 2)
 *   --dry-run      Only list what would be imported; do not copy or insert
 *
 * Always enforces: per-user storage limit and admin-configured max file size (checked before any copy).
 * Preserves file and folder modification times (mtime) from the source drive.
 */

import '../config/env.js';

import path from 'path';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

import mime from 'mime-types';

import { UPLOAD_DIR } from '../config/paths.js';
import { createByteCountStream, createEncryptStream } from '../utils/fileEncryption.js';
import { generateId } from '../utils/id.js';
import storage from '../utils/storageDriver.js';

import { runBulkImport } from './bulkImportDrive.js';

async function copyOneFile(filePath, name, dryRun, modified = null) {
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

  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  const destPath = path.join(UPLOAD_DIR, storageName);
  const writeStream = createWriteStream(destPath);

  // Swallow stream errors so EPIPE doesn't kill the process
  readStream.on('error', () => {});
  byteCount.stream.on('error', () => {});
  encryptStream.on('error', () => {});
  writeStream.on('error', () => {});

  try {
    // Count before encrypting so the recorded size is the plaintext size,
    // matching what the app's own upload path stores.
    await pipeline(readStream, byteCount.stream, encryptStream, writeStream);
  } catch (err) {
    readStream.destroy();
    try {
      await fs.unlink(destPath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  const size = byteCount.getByteCount();

  return { id, storageName, name, size, mimeType, modified };
}

runBulkImport({
  scriptName: 'scripts/bulk-import-drive-to-local.js',
  checkStorageDriver: () =>
    storage.useS3() ? 'STORAGE_DRIVER must be local. Set STORAGE_DRIVER=local and UPLOAD_DIR in .env.' : null,
  writeVerb: 'copy',
  writeVerbIng: 'Copying',
  storeOneFile: copyOneFile,
}).catch(err => {
  console.error(err);
  process.exit(1);
});
