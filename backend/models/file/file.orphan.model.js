/**
 * Orphan inspection and admin-driven cleanup. An orphan is either a *storage
 * orphan* (an object no `files` row points at) or a *database orphan* (a row
 * whose `path` points at missing storage). Both are reported, never deleted
 * automatically — deletion happens only when the first user picks entries in the
 * admin UI, and each is re-verified at that moment.
 *
 * A grace window skips anything "in flight": writes aren't atomic across storage
 * and Postgres (the object lands before the row), so a fresh object legitimately
 * has no row yet. Age comes from `created_at`, not `modified` — uploads preserve
 * the client's mtime, and renames/moves leave `path`/`created_at` alone.
 */

import path from 'path';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { invalidateAllFileCaches } from '../../utils/cache.js';
import storage from '../../utils/storageDriver.js';

/** Default age an item must reach before it can be considered an orphan. */
const DEFAULT_GRACE_MINUTES = 24 * 60;
/** Never allow the admin to scan or delete below this age — protects in-flight writes. */
const MIN_GRACE_MINUTES = 60;
/** One year; anything beyond this is pointless as a filter. */
const MAX_GRACE_MINUTES = 525600;
/** Cap on entries returned per category so a huge bucket cannot blow up the response. */
const MAX_REPORTED_PER_CATEGORY = 2000;
/** Cap on entries accepted in a single delete request. */
const MAX_DELETE_BATCH = 500;

/**
 * Clamp a caller-supplied grace window into the allowed range.
 * @param {unknown} value - Minutes, possibly undefined or malformed
 * @returns {number} A safe grace window in minutes
 */
function normalizeGraceMinutes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_GRACE_MINUTES;
  return Math.min(MAX_GRACE_MINUTES, Math.max(MIN_GRACE_MINUTES, Math.floor(parsed)));
}

/**
 * Legacy rows stored absolute filesystem paths. Those are not storage keys and
 * are excluded from orphan handling entirely.
 * @param {string} filePath
 * @returns {boolean}
 */
function isStorageKey(filePath) {
  return Boolean(filePath) && !path.isAbsolute(filePath) && !filePath.startsWith('/');
}

/**
 * Load every `files` row that maps to a storage key, including trashed rows.
 * Trashed rows still own their objects, so they must count as "referenced".
 * @returns {Promise<Array<Object>>}
 */
async function loadStorageBackedRows() {
  const result = await pool.query(
    `SELECT f.id, f.name, f.path, f.size, f.mime_type, f.modified, f.created_at, f.deleted_at,
            f.user_id, u.email AS user_email, u.name AS user_name
     FROM files f
     LEFT JOIN users u ON u.id = f.user_id
     WHERE f.type = 'file' AND f.path IS NOT NULL`
  );
  return result.rows.filter(row => isStorageKey(row.path));
}

/**
 * Scan storage and the database for orphans without deleting anything. A single
 * pass over the bucket/upload dir, with memory bounded by DB row count (matched
 * keys tracked in a set; unreferenced keys retained only up to the report cap).
 * @param {Object} [options]
 * @param {number} [options.graceMinutes] - Minimum age before an item is reported
 * @returns {Promise<Object>} Report with both orphan categories and their totals
 */
async function scanOrphans({ graceMinutes } = {}) {
  const grace = normalizeGraceMinutes(graceMinutes);
  const cutoff = new Date(Date.now() - grace * 60 * 1000);
  const startedAt = Date.now();

  const rows = await loadStorageBackedRows();
  const referencedPaths = new Set(rows.map(row => row.path));

  const storageOrphans = [];
  let storageOrphanCount = 0;
  let storageOrphanBytes = 0;
  let skippedTooRecent = 0;
  let totalObjects = 0;
  const pathsSeenInStorage = new Set();

  for await (const page of storage.listObjectsPaginated(1000)) {
    for (const object of page) {
      totalObjects += 1;

      if (referencedPaths.has(object.key)) {
        pathsSeenInStorage.add(object.key);
        continue;
      }

      // Unreferenced. Only an orphan once it is past the grace window —
      // otherwise it is very likely an upload or paste still in progress.
      if (!object.lastModified || object.lastModified > cutoff) {
        skippedTooRecent += 1;
        continue;
      }

      storageOrphanCount += 1;
      storageOrphanBytes += object.size || 0;
      if (storageOrphans.length < MAX_REPORTED_PER_CATEGORY) {
        storageOrphans.push({
          key: object.key,
          size: object.size || 0,
          lastModified: object.lastModified ? object.lastModified.toISOString() : null,
        });
      }
    }
  }

  const dbOrphans = [];
  let dbOrphanCount = 0;
  let dbOrphanBytes = 0;

  for (const row of rows) {
    if (pathsSeenInStorage.has(row.path)) continue;

    // Row exists but its object does not. Same reasoning as above in reverse:
    // the row may have been inserted moments ago by a write that has not
    // finished putting the object yet.
    const createdAt = row.created_at ? new Date(row.created_at) : null;
    if (!createdAt || createdAt > cutoff) {
      skippedTooRecent += 1;
      continue;
    }

    dbOrphanCount += 1;
    dbOrphanBytes += Number(row.size) || 0;
    if (dbOrphans.length < MAX_REPORTED_PER_CATEGORY) {
      dbOrphans.push({
        id: row.id,
        name: row.name,
        path: row.path,
        size: Number(row.size) || 0,
        mimeType: row.mime_type,
        modified: row.modified ? new Date(row.modified).toISOString() : null,
        createdAt: createdAt.toISOString(),
        trashed: Boolean(row.deleted_at),
        ownerEmail: row.user_email || null,
        ownerName: row.user_name || null,
      });
    }
  }

  logger.info(
    {
      graceMinutes: grace,
      totalObjects,
      totalRows: rows.length,
      storageOrphanCount,
      dbOrphanCount,
      skippedTooRecent,
      durationMs: Date.now() - startedAt,
    },
    '[Orphans] Scan completed'
  );

  return {
    scannedAt: new Date().toISOString(),
    graceMinutes: grace,
    driver: storage.useS3() ? 's3' : 'local',
    totals: {
      storedObjects: totalObjects,
      databaseRows: rows.length,
      skippedTooRecent,
    },
    storageOrphans: {
      items: storageOrphans,
      count: storageOrphanCount,
      totalBytes: storageOrphanBytes,
      truncated: storageOrphanCount > storageOrphans.length,
    },
    databaseOrphans: {
      items: dbOrphans,
      count: dbOrphanCount,
      totalBytes: dbOrphanBytes,
      truncated: dbOrphanCount > dbOrphans.length,
    },
  };
}

/**
 * Re-check and delete a storage object the admin flagged as orphaned.
 * @param {string} key - Storage key
 * @param {Date} cutoff - Object must be older than this
 * @returns {Promise<{ key: string, deleted: boolean, reason?: string }>}
 */
async function deleteStorageOrphan(key, cutoff) {
  if (!isStorageKey(key)) {
    return { key, deleted: false, reason: 'Not a valid storage key' };
  }

  const referencing = await pool.query('SELECT 1 FROM files WHERE path = $1 LIMIT 1', [key]);
  if (referencing.rowCount > 0) {
    return { key, deleted: false, reason: 'A file now references this object' };
  }

  const stat = await storage.statObject(key);
  if (!stat) {
    return { key, deleted: false, reason: 'Object no longer exists' };
  }
  if (!stat.lastModified || stat.lastModified > cutoff) {
    return { key, deleted: false, reason: 'Object was written too recently' };
  }

  await storage.deleteObject(key);
  return { key, deleted: true };
}

/**
 * Re-check and delete a database row the admin flagged as orphaned.
 * @param {string} id - File row id
 * @param {Date} cutoff - Row must be older than this
 * @returns {Promise<{ id: string, deleted: boolean, userId?: string, reason?: string }>}
 */
async function deleteDatabaseOrphan(id, cutoff) {
  const result = await pool.query("SELECT id, path, user_id, created_at FROM files WHERE id = $1 AND type = 'file'", [
    id,
  ]);
  const row = result.rows[0];
  if (!row) {
    return { id, deleted: false, reason: 'Row no longer exists' };
  }
  if (!isStorageKey(row.path)) {
    return { id, deleted: false, reason: 'Row does not map to a storage key' };
  }
  if (!row.created_at || new Date(row.created_at) > cutoff) {
    return { id, deleted: false, reason: 'Row was created too recently' };
  }
  if (await storage.exists(row.path)) {
    return { id, deleted: false, reason: 'Stored object exists again' };
  }

  await pool.query('DELETE FROM files WHERE id = $1', [id]);
  return { id, deleted: true, userId: row.user_id };
}

/**
 * Delete the orphans an admin selected, re-verifying each first (against the DB
 * and storage timestamp) — nothing is deleted on the scan alone. Entries that no
 * longer qualify come back as skipped.
 * @param {Object} selection
 * @param {string[]} [selection.storageKeys] - Storage orphan keys to delete
 * @param {string[]} [selection.fileIds] - Database orphan row ids to delete
 * @param {number} [selection.graceMinutes] - Same window used for the scan
 * @returns {Promise<Object>} Per-item outcomes and counts
 */
async function deleteOrphans({ storageKeys = [], fileIds = [], graceMinutes } = {}) {
  const grace = normalizeGraceMinutes(graceMinutes);
  const cutoff = new Date(Date.now() - grace * 60 * 1000);

  const keys = [...new Set(storageKeys)].slice(0, MAX_DELETE_BATCH);
  const ids = [...new Set(fileIds)].slice(0, MAX_DELETE_BATCH);

  const storageResults = [];
  for (const key of keys) {
    try {
      storageResults.push(await deleteStorageOrphan(key, cutoff));
    } catch (err) {
      logger.error({ err, key }, '[Orphans] Failed to delete storage orphan');
      storageResults.push({ key, deleted: false, reason: err.message || 'Deletion failed' });
    }
  }

  const databaseResults = [];
  const affectedUserIds = new Set();
  for (const id of ids) {
    try {
      const outcome = await deleteDatabaseOrphan(id, cutoff);
      if (outcome.userId) affectedUserIds.add(outcome.userId);
      databaseResults.push({ id: outcome.id, deleted: outcome.deleted, reason: outcome.reason });
    } catch (err) {
      logger.error({ err, fileId: id }, '[Orphans] Failed to delete database orphan');
      databaseResults.push({ id, deleted: false, reason: err.message || 'Deletion failed' });
    }
  }

  for (const userId of affectedUserIds) {
    await invalidateAllFileCaches(userId);
  }

  const storageDeleted = storageResults.filter(r => r.deleted).length;
  const databaseDeleted = databaseResults.filter(r => r.deleted).length;

  logger.info(
    {
      graceMinutes: grace,
      requestedStorage: keys.length,
      requestedDatabase: ids.length,
      storageDeleted,
      databaseDeleted,
    },
    '[Orphans] Admin-requested cleanup completed'
  );

  return {
    graceMinutes: grace,
    storage: { results: storageResults, deleted: storageDeleted, skipped: storageResults.length - storageDeleted },
    database: { results: databaseResults, deleted: databaseDeleted, skipped: databaseResults.length - databaseDeleted },
  };
}

export {
  scanOrphans,
  deleteOrphans,
  normalizeGraceMinutes,
  DEFAULT_GRACE_MINUTES,
  MIN_GRACE_MINUTES,
  MAX_GRACE_MINUTES,
  MAX_DELETE_BATCH,
};
