/**
 * Bulk drive-import orchestration.
 *
 * Import a folder tree into bucket storage: scan the
 * tree, preflight it against the per-file and per-user limits, recreate the
 * folder hierarchy, then stream every file through encryption into storage and
 * insert the matching DB row for each encrypted bucket object.
 *
 */

import path from 'path';
import fs from 'fs/promises';

import pool from '../config/db.js';
import { getMaxUploadSizeSettings } from '../models/user.model.js';
import { createFolder, createFileFromStreamedUpload } from '../models/file/file.crud.model.js';
import { invalidateUserCache } from '../utils/cache.js';
import storage from '../utils/storageDriver.js';
import { checkStorageLimitExceeded } from '../utils/storageUtils.js';
import { validateFileName } from '../utils/validation.js';

if (!process.env.DOCKER && process.env.DB_HOST === 'postgres') process.env.DB_HOST = 'localhost';
if (!process.env.DOCKER && process.env.REDIS_HOST === 'redis') process.env.REDIS_HOST = 'localhost';

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
  let sanitized = name.replace(/\.{2}/g, '.');
  sanitized = sanitized.replace(/[<>:"\\/|?*]/g, '_');
  sanitized = sanitized.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!sanitized || sanitized === '') sanitized = 'file_' + Date.now();
  return sanitized;
}

/**
 * @param {object} options
 * @param {string} options.scriptName   Script path shown in the usage hint (e.g. 'scripts/bulk-import-drive-to-s3.js').
 * @param {string} options.writeVerb    Lowercase verb for messages ('upload', 'copy').
 * @param {string} options.writeVerbIng Progress-line verb ('Uploading', 'Copying').
 * @param {(filePath: string, name: string, dryRun: boolean, modified: Date | null) => Promise<object>}
 *   options.storeOneFile  Encrypts and writes a single file, resolving with its DB metadata.
 */
async function runBulkImport({ scriptName, writeVerb, writeVerbIng, storeOneFile }) {
  const args = parseArgs();
  if (!args.sourceDir) {
    console.error(`Missing --source-dir. Usage: node ${scriptName} --source-dir "D:\\MyDrive" --user-id YOUR_USER_ID`);
    process.exit(1);
  }

  const stat = await fs.stat(args.sourceDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    console.error('Source path is not a directory:', args.sourceDir);
    process.exit(1);
  }

  if (!process.env.FILE_ENCRYPTION_KEY) {
    console.warn('WARNING: FILE_ENCRYPTION_KEY is not set. App will use development default; ensure consistency.');
  }

  const settings = await getMaxUploadSizeSettings();
  const MAX_FILE_SIZE = settings.maxBytes;
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
  let aborted = false;
  let firstError = null;
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
    const fileStat = await fs.stat(f.fullPath).catch(() => null);
    if (!fileStat) continue;
    totalSize += fileStat.size;
    if (fileStat.size > MAX_FILE_SIZE) {
      oversize.push({ path: f.relPath, size: fileStat.size });
    }
  }
  if (oversize.length > 0) {
    const list = oversize.map(o => `${o.path} (${formatSize(o.size)})`).join(', ');
    throw new Error(
      `Import aborted before any ${writeVerb}. The following file(s) exceed the ${formatSize(MAX_FILE_SIZE)} per-file limit: ${list}. ` +
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
      `Import aborted before any ${writeVerb}. Total size would exceed storage limit: ${check.message || 'Storage limit exceeded'}`
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

  console.log(writeVerbIng, files.length, 'files (concurrency:', args.concurrency, ')...');
  let done = 0;
  let totalBytes = 0;
  const failed = [];
  const queue = [...files];
  const inFlight = new Set();

  function getParentId(itemRelPath) {
    const dir = path.dirname(itemRelPath).replace(/\\/g, '/');
    return relToFolderId[dir] ?? null;
  }

  async function processNext() {
    if (aborted) return;
    if (queue.length === 0) return;
    const item = queue.shift();
    if (!item) return;

    let { fullPath, relPath: itemRelPath, name } = item;
    const originalName = name;
    if (!validateFileName(name)) {
      name = sanitizeFileName(name);
      console.warn(`Sanitizing invalid filename: "${originalName}" -> "${name}"`);
    }

    const parentId = getParentId(itemRelPath);
    const key = fullPath;
    inFlight.add(key);

    try {
      const fileStat = await fs.stat(fullPath);
      if (fileStat.size > MAX_FILE_SIZE) {
        throw new Error(`File exceeds ${formatSize(MAX_FILE_SIZE)} limit: ${itemRelPath}`);
      }
      const usage = await getStorageUsageAndLimit(userId);
      const fileCheck = await checkStorageLimitExceeded({
        fileSize: fileStat.size,
        used: usage.used,
        userStorageLimit: usage.userStorageLimit,
      });
      if (fileCheck.exceeded) {
        throw new Error(fileCheck.message || 'Storage limit exceeded');
      }

      const modified = fileStat.mtime ? new Date(fileStat.mtime) : null;
      const storedMeta = await storeOneFile(fullPath, name, false, modified);
      await createFileFromStreamedUpload(
        {
          id: storedMeta.id,
          storageName: storedMeta.storageName,
          name: storedMeta.name,
          size: storedMeta.size,
          mimeType: storedMeta.mimeType,
          modified: storedMeta.modified,
          dekWrapped: storedMeta.dekWrapped,
          dekKekVersion: storedMeta.dekKekVersion,
        },
        parentId,
        userId
      );
      committedFiles.push({ ...storedMeta, parentId });
      totalBytes += storedMeta.size;
      done++;
      if (done % 50 === 0 || done === files.length) {
        console.log(`Progress: ${done}/${files.length} files, ${formatSize(totalBytes)}`);
      }
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : String(err);
      failed.push({ path: itemRelPath, error: msg });
      console.error('Failed:', itemRelPath, msg);
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
    console.error('Import aborted due to first error. Rolling back all changes...');
    for (const fileMeta of committedFiles) {
      try {
        await pool.query('DELETE FROM files WHERE id = $1 AND user_id = $2', [fileMeta.id, userId]);
      } catch (rollbackErr) {
        console.error('Failed to roll back file DB record', fileMeta.id, rollbackErr.message || rollbackErr);
      }
      try {
        await storage.deleteObject(fileMeta.storageName);
      } catch (rollbackErr) {
        console.error('Failed to delete stored object', fileMeta.storageName, rollbackErr.message || rollbackErr);
      }
    }
    for (let i = createdFolderIds.length - 1; i >= 0; i -= 1) {
      const folderId = createdFolderIds[i];
      try {
        await pool.query('DELETE FROM files WHERE id = $1 AND user_id = $2', [folderId, userId]);
      } catch (rollbackErr) {
        console.error('Failed to roll back folder with id', folderId, rollbackErr.message || rollbackErr);
      }
    }

    console.error(
      'Rollback complete. Rolled back',
      committedFiles.length,
      'files and',
      createdFolderIds.length,
      'folders.'
    );
    throw firstError;
  }

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

export { runBulkImport };
