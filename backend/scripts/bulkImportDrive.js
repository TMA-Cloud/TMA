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
import { randomUUID } from 'crypto';

import pool from '../config/db.js';
import { getMaxUploadSizeSettings } from '../models/user.model.js';
import { createFolder, createFilesFromStreamedUploads } from '../models/file/file.crud.model.js';
import { invalidateUserCache } from '../utils/cache.js';
import storage from '../utils/storageDriver.js';
import { checkStorageLimitExceeded } from '../utils/storageUtils.js';
import { validateFileName } from '../utils/validation.js';

if (!process.env.DOCKER && process.env.DB_HOST === 'postgres') process.env.DB_HOST = 'localhost';
if (!process.env.DOCKER && process.env.REDIS_HOST === 'redis') process.env.REDIS_HOST = 'localhost';

async function getStorageUsageAndLimit(userId) {
  const account = await pool.query('SELECT storage_used, storage_limit FROM users WHERE id = $1', [userId]);
  const used = Number(account.rows[0]?.storage_used) || 0;
  const raw = account.rows[0]?.storage_limit;
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

async function* walkTree(dir, baseDir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = relPath(baseDir, full);
    if (e.isDirectory()) {
      yield { kind: 'directory', fullPath: full, relPath: rel, name: e.name };
      yield* walkTree(full, baseDir);
    } else if (e.isFile()) {
      yield { kind: 'file', fullPath: full, relPath: rel, name: e.name };
    }
  }
}

function pathDepth(rel) {
  return rel ? rel.split('/').length : 0;
}

async function rollbackImport(runId, userId) {
  let rolledBackFiles = 0;
  let rolledBackFolders = 0;
  for (;;) {
    const result = await pool.query(
      `SELECT file_id, storage_name, item_type
         FROM bulk_import_items
        WHERE run_id = $1 AND user_id = $2
        ORDER BY CASE WHEN item_type = 'file' THEN 0 ELSE 1 END, depth DESC, file_id
        LIMIT 500`,
      [runId, userId]
    );
    if (result.rows.length === 0) break;
    const storageNames = result.rows.filter(row => row.storage_name).map(row => row.storage_name);
    if (storageNames.length > 0) {
      if (typeof storage.deleteObjects === 'function') {
        const deletion = await storage.deleteObjects(storageNames);
        if (deletion?.errors?.length) throw new Error(`${deletion.errors.length} rollback object deletion(s) failed`);
      } else {
        await Promise.all(storageNames.map(key => storage.deleteObject(key)));
      }
    }
    const ids = result.rows.map(row => row.file_id);
    await pool.query('DELETE FROM files WHERE user_id = $1 AND id = ANY($2::text[])', [userId, ids]);
    await pool.query('DELETE FROM bulk_import_items WHERE run_id = $1 AND file_id = ANY($2::text[])', [runId, ids]);
    rolledBackFiles += result.rows.filter(row => row.item_type === 'file').length;
    rolledBackFolders += result.rows.filter(row => row.item_type === 'folder').length;
  }
  return { rolledBackFiles, rolledBackFolders };
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
  const runId = randomUUID();

  console.log('Preflight: scanning file sizes and storage limit...');
  let directoryCount = 0;
  let fileCount = 0;
  let totalSize = 0;
  let oversizeCount = 0;
  const oversizeExamples = [];
  for await (const item of walkTree(args.sourceDir, args.sourceDir)) {
    if (item.kind === 'directory') {
      directoryCount += 1;
      continue;
    }
    fileCount += 1;
    const fileStat = await fs.stat(item.fullPath).catch(() => null);
    if (!fileStat) continue;
    totalSize += fileStat.size;
    if (fileStat.size > MAX_FILE_SIZE) {
      oversizeCount += 1;
      if (oversizeExamples.length < 20) oversizeExamples.push({ path: item.relPath, size: fileStat.size });
    }
  }

  if (args.dryRun) {
    console.log('Dry run: would create', directoryCount, 'folders and', fileCount, 'files.');
    console.log('Total size (plain):', formatSize(totalSize));
    return;
  }
  if (oversizeCount > 0) {
    const list = oversizeExamples.map(o => `${o.path} (${formatSize(o.size)})`).join(', ');
    const remainder =
      oversizeCount > oversizeExamples.length ? `, and ${oversizeCount - oversizeExamples.length} more` : '';
    throw new Error(
      `Import aborted before any ${writeVerb}. ${oversizeCount} file(s) exceed the ${formatSize(MAX_FILE_SIZE)} per-file limit: ${list}${remainder}. ` +
        'Remove or split these files, or increase the max upload size in Settings.'
    );
  }
  const { used, userStorageLimit } = await getStorageUsageAndLimit(userId);
  const check = await checkStorageLimitExceeded({ fileSize: totalSize, used, userStorageLimit });
  if (check.exceeded) {
    throw new Error(
      `Import aborted before any ${writeVerb}. Total size would exceed storage limit: ${check.message || 'Storage limit exceeded'}`
    );
  }
  console.log('Preflight OK:', directoryCount, 'folders,', fileCount, 'files,', formatSize(totalSize));

  const relToFolderId = new Map([['', null]]);
  let aborted = false;
  let firstError = null;
  console.log(writeVerbIng, fileCount, 'files (concurrency:', args.concurrency, ')...');
  let done = 0;
  let totalBytes = 0;

  function getParentId(itemRelPath) {
    const dir = path.dirname(itemRelPath).replace(/\\/g, '/');
    return relToFolderId.get(dir) ?? null;
  }

  async function uploadOne(item) {
    let { fullPath, relPath: itemRelPath, name } = item;
    const originalName = name;
    if (!validateFileName(name)) {
      name = sanitizeFileName(name);
      console.warn(`Sanitizing invalid filename: "${originalName}" -> "${name}"`);
    }

    const parentId = getParentId(itemRelPath);
    try {
      const fileStat = await fs.stat(fullPath);
      if (fileStat.size > MAX_FILE_SIZE) {
        throw new Error(`File exceeds ${formatSize(MAX_FILE_SIZE)} limit: ${itemRelPath}`);
      }
      const modified = fileStat.mtime ? new Date(fileStat.mtime) : null;
      const storedMeta = await storeOneFile(fullPath, name, false, modified);
      return {
        upload: storedMeta,
        parentId,
        modified,
        sourcePath: itemRelPath,
        importDepth: pathDepth(itemRelPath),
      };
    } catch (err) {
      const msg = err && typeof err.message === 'string' ? err.message : String(err);
      console.error('Failed:', itemRelPath, msg);
      throw err;
    }
  }

  const batchSize = 250;
  let sourceBatch = [];
  async function commitBatch() {
    if (sourceBatch.length === 0) return;
    const uploaded = [];
    let next = 0;
    try {
      const workers = Array.from({ length: Math.min(args.concurrency, sourceBatch.length) }, async () => {
        for (;;) {
          const index = next++;
          if (index >= sourceBatch.length) return;
          uploaded.push(await uploadOne(sourceBatch[index]));
        }
      });
      const workerResults = await Promise.allSettled(workers);
      const rejected = workerResults.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      await createFilesFromStreamedUploads(uploaded, userId, { importRunId: runId });
      for (const entry of uploaded) {
        totalBytes += Number(entry.upload.size) || 0;
      }
      done += uploaded.length;
      console.log(`Progress: ${done}/${fileCount} files, ${formatSize(totalBytes)}`);
    } catch (error) {
      aborted = true;
      firstError = error;
      // The batch transaction is all-or-nothing, so none of these objects have
      // durable metadata when finalization fails.
      await Promise.allSettled(uploaded.map(entry => storage.deleteObject(entry.upload.storageName)));
    }
    sourceBatch = [];
  }

  try {
    for await (const item of walkTree(args.sourceDir, args.sourceDir)) {
      if (aborted) break;
      if (item.kind === 'directory') {
        await commitBatch();
        if (!validateFileName(item.name)) throw new Error(`Invalid folder name: ${item.relPath}`);
        const parentRel = path.dirname(item.relPath).replace(/\\/g, '/');
        const parentId = relToFolderId.get(parentRel) ?? null;
        const dirStat = await fs.stat(item.fullPath).catch(() => null);
        const folder = await createFolder(item.name, parentId, userId, dirStat?.mtime || null, {
          importRunId: runId,
          importDepth: pathDepth(item.relPath),
        });
        relToFolderId.set(item.relPath, folder.id);
      } else {
        sourceBatch.push(item);
        if (sourceBatch.length >= batchSize) await commitBatch();
      }
    }
    await commitBatch();
  } catch (error) {
    aborted = true;
    firstError ||= error;
  }

  if (aborted && firstError) {
    console.error('Import aborted due to first error. Rolling back all changes...');
    const rollback = await rollbackImport(runId, userId);
    console.error(
      'Rollback complete. Rolled back',
      rollback.rolledBackFiles,
      'files and',
      rollback.rolledBackFolders,
      'folders.'
    );
    throw firstError;
  }

  await pool.query('DELETE FROM bulk_import_items WHERE run_id = $1', [runId]);
  console.log('Done. Total files:', done, 'Total size:', formatSize(totalBytes));
  console.log('✓ All files imported successfully!');

  await invalidateUserCache(userId);
  console.log('User cache invalidated.');
}

export { runBulkImport };
