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

const path = require('path');
const fs = require('fs').promises;
const { createReadStream } = require('fs');
const dotenv = require('dotenv');

const scriptDir = __dirname;
const backendDir = path.join(scriptDir, '..');
const projectRoot = path.join(backendDir, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(backendDir, '.env') });

const storage = require('../utils/storageDriver');
const { createEncryptStream, createByteCountStream } = require('../utils/fileEncryption');
const { generateId } = require('../utils/id');
const { createFolder, createFileFromStreamedUpload } = require('../models/file/file.crud.model');
const { validateFileName } = require('../utils/validation');
const { checkStorageLimitExceeded } = require('../utils/storageUtils');
const pool = require('../config/db');
const mime = require('mime-types');
const { getMaxUploadSizeSettings } = require('../models/user.model');

/** Resolved once at startup from app_settings (admin-configurable). */
let MAX_FILE_SIZE;

/**
 * Get user storage usage and limit via direct DB (no Redis/cache).
 * Use in script to avoid "Unable to verify storage limit" when Redis is down or not used.
 */
async function getStorageUsageAndLimit(userId) {
  const [usageRes, limitRes] = await Promise.all([
    pool.query("SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = $1 AND type = 'file'", [userId]),
    pool.query('SELECT storage_limit FROM users WHERE id = $1', [userId]),
  ]);
  const used = Number(usageRes.rows[0]?.used) || 0;
  const raw = limitRes.rows[0]?.storage_limit;
  const userStorageLimit = raw === null || raw === undefined ? null : typeof raw === 'number' ? raw : Number(raw);
  const limit = userStorageLimit !== null && Number.isFinite(userStorageLimit) ? userStorageLimit : null;
  return { used, userStorageLimit: limit };
}

/**
 * Format bytes into a human-readable string (MB or GB with 2 decimals).
 * Keeps progress accurate for small imports (e.g., 10–100 MB) and large ones.
 */
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) {
    return `${mb.toFixed(2)} MB`;
  }
  const gb = bytes / (1024 * 1024 * 1024);
  return `${gb.toFixed(2)} GB`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    sourceDir: null,
    userId: null,
    userEmail: null,
    concurrency: 2,
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--source-dir' && args[i + 1]) {
      out.sourceDir = path.resolve(args[++i]);
    } else if (args[i] === '--user-id' && args[i + 1]) {
      out.userId = args[++i];
    } else if (args[i] === '--user-email' && args[i + 1]) {
      out.userEmail = args[++i];
    } else if (args[i] === '--concurrency' && args[i + 1]) {
      out.concurrency = Math.max(1, parseInt(args[++i], 10) || 2);
    } else if (args[i] === '--dry-run') {
      out.dryRun = true;
    }
  }
  return out;
}

/**
 * Normalize relative path to use forward slashes for consistent mapping
 */
function relPath(base, fullPath) {
  const rel = path.relative(base, fullPath);
  return rel.split(path.sep).join('/');
}

/**
 * Recursively collect all directory and file paths under dir
 */
async function walkDir(dir, baseDir, dirs, files) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = relPath(baseDir, full);
    if (e.isDirectory()) {
      dirs.push(rel);
      await walkDir(full, baseDir, dirs, files);
    } else if (e.isFile()) {
      files.push({ fullPath: full, relPath: rel, name: e.name });
    }
  }
}

/**
 * Sort directory paths so parent comes before child (e.g. "a" before "a/b")
 */
function sortDirsForCreation(dirs) {
  return [...dirs].sort((a, b) => {
    const depthA = (a.match(/\//g) || []).length;
    const depthB = (b.match(/\//g) || []).length;
    if (depthA !== depthB) return depthA - depthB;
    return a.localeCompare(b);
  });
}

async function resolveUserId(userId, userEmail) {
  if (userId) {
    const r = await pool.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (r.rows.length === 0) throw new Error(`User not found: ${userId}`);
    return userId;
  }
  if (userEmail) {
    const r = await pool.query('SELECT id FROM users WHERE email = $1', [userEmail]);
    if (r.rows.length === 0) throw new Error(`User not found for email: ${userEmail}`);
    return r.rows[0].id;
  }
  throw new Error('Provide either --user-id or --user-email');
}

/**
 * @param {Date|null} modified - Optional mtime from source file (preserved in DB)
 */
async function uploadOneFile(filePath, name, parentId, userId, dryRun, modified = null) {
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

  readStream.pipe(byteCount.stream).pipe(encryptStream);

  await storage.putStream(storageName, encryptStream);
  const size = byteCount.getByteCount();

  // NOTE: DB insert is done by caller so it can respect global abort flag.
  return { id, storageName, name, size, mimeType, modified };
}

async function run() {
  const args = parseArgs();
  if (!args.sourceDir) {
    console.error(
      'Missing --source-dir. Usage: node scripts/bulk-import-drive-to-s3.js --source-dir "D:\\MyDrive" --user-id YOUR_USER_ID'
    );
    process.exit(1);
  }

  const stat = await fs.stat(args.sourceDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error('Source path is not a directory:', args.sourceDir);
    process.exit(1);
  }

  if (!storage.useS3()) {
    console.error('STORAGE_DRIVER must be s3. Set STORAGE_DRIVER=s3 and RUSTFS_* (or AWS_*) in .env.');
    process.exit(1);
  }

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.warn('WARNING: FILE_ENCRYPTION_KEY is not set. App will use development default; ensure consistency.');
  }

  // Load admin-configured max upload size from app_settings
  const settings = await getMaxUploadSizeSettings();
  MAX_FILE_SIZE = settings.maxBytes;
  if (!MAX_FILE_SIZE || !Number.isFinite(MAX_FILE_SIZE) || MAX_FILE_SIZE <= 0) {
    throw new Error('Failed to load max upload size from app_settings. Ensure the database has been migrated.');
  }
  console.log('Max file size from settings:', formatSize(MAX_FILE_SIZE));

  const userId = await resolveUserId(args.userId, args.userEmail);

  console.log('Scanning directory tree...');
  const dirs = [];
  const files = [];
  await walkDir(args.sourceDir, args.sourceDir, dirs, files);

  const sortedDirs = sortDirsForCreation(dirs);
  const relToFolderId = { '': null };
  const createdFolderIds = []; // track folders created in this run for rollback on failure
  let aborted = false;
  let firstError = null;
  const uploadedFiles = []; // S3 uploads that completed successfully (DB insert deferred)

  if (args.dryRun) {
    console.log('Dry run: would create', sortedDirs.length, 'folders and', files.length, 'files.');
    let totalBytes = 0;
    for (const f of files) {
      const s = await fs.stat(f.fullPath).catch(() => null);
      if (s) totalBytes += s.size;
    }
    console.log('Total size (plain):', formatSize(totalBytes));
    return;
  }

  // Preflight: validate ALL file sizes and total vs storage limit BEFORE creating folders or uploading.
  // This way we never upload a single byte or write DB if the set would fail (e.g. 10GB+ single file).
  console.log('Preflight: checking file sizes and storage limit...');
  let totalSize = 0;
  const oversize = [];
  for (const f of files) {
    const stat = await fs.stat(f.fullPath).catch(() => null);
    if (!stat) continue;
    totalSize += stat.size;
    if (stat.size > MAX_FILE_SIZE) {
      oversize.push({ path: f.relPath, size: stat.size });
    }
  }
  if (oversize.length > 0) {
    const list = oversize.map(o => `${o.path} (${formatSize(o.size)})`).join(', ');
    throw new Error(
      `Import aborted before any upload. The following file(s) exceed the ${formatSize(MAX_FILE_SIZE)} per-file limit: ${list}. ` +
        'Remove or split these files, or increase the max upload size in Settings.'
    );
  }
  const { used, userStorageLimit } = await getStorageUsageAndLimit(userId);
  const check = await checkStorageLimitExceeded({
    fileSize: totalSize,
    used,
    userStorageLimit,
  });
  if (check.exceeded) {
    throw new Error(
      `Import aborted before any upload. Total size would exceed storage limit: ${check.message || 'Storage limit exceeded'}`
    );
  }
  console.log('Preflight OK. Total size:', formatSize(totalSize));

  console.log('Creating', sortedDirs.length, 'folders...');
  for (const rel of sortedDirs) {
    const dirName = path.basename(rel);
    const parentRel = path.dirname(rel).replace(/\\/g, '/');
    const parentId = relToFolderId[parentRel] ?? null;

    if (!validateFileName(dirName)) {
      console.warn('Skipping invalid folder name:', rel);
      continue;
    }
    const fullDirPath = path.join(args.sourceDir, rel);
    let modified = null;
    try {
      const dirStat = await fs.stat(fullDirPath);
      modified = dirStat.mtime;
    } catch {
      // use default (NOW()) if stat fails
    }
    const folder = await createFolder(dirName, parentId, userId, modified);
    relToFolderId[rel] = folder.id;
    createdFolderIds.push(folder.id);
  }

  console.log('Uploading', files.length, 'files (concurrency:', args.concurrency, ')...');
  let done = 0;
  let totalBytes = 0;
  const failed = [];
  const queue = [...files];
  const inFlight = new Set();

  function getParentId(relPath) {
    const dir = path.dirname(relPath).replace(/\\/g, '/');
    return relToFolderId[dir] ?? null;
  }

  async function processNext() {
    if (aborted) return;
    if (queue.length === 0) return;
    const item = queue.shift();
    if (!item) return;

    const { fullPath, relPath, name } = item;
    if (!validateFileName(name)) {
      // Treat invalid names as a hard error so the import can be fixed and rerun deterministically
      throw new Error(`Invalid file name: ${relPath}`);
    }

    const parentId = getParentId(relPath);
    const key = fullPath;
    inFlight.add(key);

    try {
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE) {
        // Abort the whole import on first oversize file
        throw new Error(`File exceeds ${formatSize(MAX_FILE_SIZE)} limit: ${relPath}`);
      }
      const { used, userStorageLimit } = await getStorageUsageAndLimit(userId);
      const check = await checkStorageLimitExceeded({
        fileSize: stat.size,
        used,
        userStorageLimit,
      });
      if (check.exceeded) {
        throw new Error(check.message || 'Storage limit exceeded');
      }

      const modified = stat.mtime ? new Date(stat.mtime) : null;
      const uploadMeta = await uploadOneFile(fullPath, name, parentId, userId, false, modified);

      // Record successful S3 upload; DB insert is done later only if the whole import succeeds.
      uploadedFiles.push({ ...uploadMeta, parentId });
      totalBytes += uploadMeta.size;
      done++;
      if (done % 50 === 0 || done === files.length) {
        console.log(`Progress: ${done}/${files.length} files, ${formatSize(totalBytes)}`);
      }
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : String(err);
      failed.push({ path: relPath, error: msg });
      console.error('Failed:', relPath, msg);
      if (err && err.stack) console.error(err.stack);
      done++;
      if (!aborted) {
        aborted = true;
        firstError = err;
      }
    } finally {
      inFlight.delete(key);
      if (!aborted && queue.length > 0) await processNext();
    }
  }

  const concurrency = Math.min(args.concurrency, files.length);
  await Promise.allSettled(Array.from({ length: concurrency }, () => processNext()));

  if (aborted && firstError) {
    console.error('Import aborted due to first error. No file records were written to the database.');

    // Roll back folders created in this run (best-effort; ignore errors).
    for (let i = createdFolderIds.length - 1; i >= 0; i -= 1) {
      const folderId = createdFolderIds[i];
      try {
        // Delete only the exact ids we created for this user.
        // Children were also created in this run, so deleting in reverse order is safe.
        await pool.query('DELETE FROM files WHERE id = $1 AND user_id = $2', [folderId, userId]);
      } catch (rollbackErr) {
        // Log but do not override the original error.
        console.error('Failed to roll back folder with id', folderId, rollbackErr.message || rollbackErr);
      }
    }

    throw firstError;
  }

  // Only now, after all uploads have succeeded, write file rows to the DB.
  console.log('Writing file metadata to database for', uploadedFiles.length, 'files...');
  for (const meta of uploadedFiles) {
    await createFileFromStreamedUpload(
      {
        id: meta.id,
        storageName: meta.storageName,
        name: meta.name,
        size: meta.size,
        mimeType: meta.mimeType,
        modified: meta.modified,
      },
      meta.parentId,
      userId
    );
  }

  console.log('Done. Total files:', uploadedFiles.length, 'Total size:', formatSize(totalBytes));
  if (failed.length > 0) {
    console.error('Failed count:', failed.length);
    failed.slice(0, 20).forEach(f => console.error('  ', f.path, f.error));
    if (failed.length > 20) console.error('  ... and', failed.length - 20, 'more');
  }

  const { invalidateUserCache } = require('../utils/cache');
  await invalidateUserCache(userId);
  console.log('User cache invalidated.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
