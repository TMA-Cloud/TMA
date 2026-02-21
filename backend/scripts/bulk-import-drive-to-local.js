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
 *   --concurrency  Max concurrent file uploads (default 2)
 *   --dry-run      Only list what would be imported; do not copy or insert
 *
 * Always enforces: per-user storage limit and admin-configured max file size (checked before any copy).
 * Preserves file and folder modification times (mtime) from the source drive.
 */

const path = require('path');
const fs = require('fs').promises;
const { createReadStream, createWriteStream } = require('fs');
const dotenv = require('dotenv');
const { pipeline } = require('stream/promises');

const scriptDir = __dirname;
const backendDir = path.join(scriptDir, '..');
const projectRoot = path.join(backendDir, '..');
dotenv.config({ path: path.join(projectRoot, '.env') });
dotenv.config({ path: path.join(backendDir, '.env') });

if (!process.env.DOCKER && process.env.DB_HOST === 'postgres') process.env.DB_HOST = 'localhost';
if (!process.env.DOCKER && process.env.REDIS_HOST === 'redis') process.env.REDIS_HOST = 'localhost';

const storage = require('../utils/storageDriver');
const { UPLOAD_DIR } = require('../config/paths');
const { createEncryptStream, createByteCountStream } = require('../utils/fileEncryption');
const { generateId } = require('../utils/id');
const { createFolder, createFileFromStreamedUpload } = require('../models/file/file.crud.model');
const { validateFileName } = require('../utils/validation');
const { checkStorageLimitExceeded } = require('../utils/storageUtils');
const pool = require('../config/db');
const mime = require('mime-types');
const { getMaxUploadSizeSettings } = require('../models/user.model');
const { invalidateUserCache } = require('../utils/cache');

let MAX_FILE_SIZE;

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

function relPath(base, fullPath) {
  const rel = path.relative(base, fullPath);
  return rel.split(path.sep).join('/');
}

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

function sanitizeFileName(name) {
  let sanitized = name.replace(/\.{2,}/g, '.');
  sanitized = sanitized.replace(/[<>:"\\/|?*]/g, '_');
  sanitized = sanitized.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!sanitized || sanitized === '') {
    sanitized = 'file_' + Date.now();
  }
  return sanitized;
}

async function copyOneFile(filePath, name, parentId, userId, dryRun, modified = null) {
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
    await pipeline(readStream, encryptStream, byteCount.stream, writeStream);
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

async function run() {
  const args = parseArgs();
  if (!args.sourceDir) {
    console.error(
      'Missing --source-dir. Usage: node scripts/bulk-import-drive-to-local.js --source-dir "D:\\MyDrive" --user-id YOUR_USER_ID'
    );
    process.exit(1);
  }

  const stat = await fs.stat(args.sourceDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error('Source path is not a directory:', args.sourceDir);
    process.exit(1);
  }

  if (storage.useS3()) {
    console.error('STORAGE_DRIVER must be local. Set STORAGE_DRIVER=local and UPLOAD_DIR in .env.');
    process.exit(1);
  }

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.warn('WARNING: FILE_ENCRYPTION_KEY is not set. App will use development default; ensure consistency.');
  }

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
  const createdFolderIds = [];
  const committedFiles = [];

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
      `Import aborted before any copy. The following file(s) exceed the ${formatSize(MAX_FILE_SIZE)} per-file limit: ${list}. ` +
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
      `Import aborted before any copy. Total size would exceed storage limit: ${check.message || 'Storage limit exceeded'}`
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
      /* ignore */
    }
    const folder = await createFolder(dirName, parentId, userId, modified);
    relToFolderId[rel] = folder.id;
    createdFolderIds.push(folder.id);
  }

  console.log('Copying', files.length, 'files (concurrency:', args.concurrency, ')...');
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
    if (queue.length === 0) return;
    const item = queue.shift();
    if (!item) return;

    let { fullPath, relPath, name } = item;
    const originalName = name;
    if (!validateFileName(name)) {
      name = sanitizeFileName(name);
      console.warn(`Sanitizing invalid filename: "${originalName}" -> "${name}"`);
    }

    const parentId = getParentId(relPath);
    const key = fullPath;
    inFlight.add(key);

    try {
      const stat = await fs.stat(fullPath);
      if (stat.size > MAX_FILE_SIZE) {
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
      const copyMeta = await copyOneFile(fullPath, name, parentId, userId, false, modified);
      await createFileFromStreamedUpload(
        {
          id: copyMeta.id,
          storageName: copyMeta.storageName,
          name: copyMeta.name,
          size: copyMeta.size,
          mimeType: copyMeta.mimeType,
          modified: copyMeta.modified,
        },
        parentId,
        userId
      );
      committedFiles.push({ ...copyMeta, parentId });
      totalBytes += copyMeta.size;
      done++;
      if (done % 50 === 0 || done === files.length) {
        console.log(`Progress: ${done}/${files.length} files, ${formatSize(totalBytes)}`);
      }
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : String(err);
      failed.push({ path: relPath, error: msg });
      console.error('Failed:', relPath, msg);
      done++;
    } finally {
      inFlight.delete(key);
      if (queue.length > 0) await processNext();
    }
  }

  const concurrency = Math.min(args.concurrency, files.length);
  await Promise.allSettled(Array.from({ length: concurrency }, () => processNext()));

  console.log('Done. Total files:', committedFiles.length, 'Total size:', formatSize(totalBytes));
  const maxDisplayFailed = 20;
  if (failed.length > 0) {
    console.error('\n Import completed with errors. Failed count:', failed.length);
    failed.slice(0, maxDisplayFailed).forEach(f => console.error(`  ${f.path}: ${f.error}`));
    if (failed.length > maxDisplayFailed) console.error(`  ... and ${failed.length - maxDisplayFailed} more`);
  } else {
    console.log('✓ All files imported successfully!');
  }

  await invalidateUserCache(userId);
  console.log('User cache invalidated.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
