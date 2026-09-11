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
 * Scan storage and the database for orphans without deleting anything. Bucket
 * pages are staged in a temporary PostgreSQL table, keeping application memory
 * bounded by one S3 page plus the capped report.
 * @param {Object} [options]
 * @param {number} [options.graceMinutes] - Minimum age before an item is reported
 * @returns {Promise<Object>} Report with both orphan categories and their totals
 */
async function scanOrphans({ graceMinutes } = {}) {
  const grace = normalizeGraceMinutes(graceMinutes);
  const cutoff = new Date(Date.now() - grace * 60 * 1000);
  const startedAt = Date.now();
  const client = await pool.connect();
  let totalObjects = 0;
  try {
    await client.query(
      `CREATE TEMP TABLE orphan_storage_inventory (
       key TEXT PRIMARY KEY,
         size BIGINT NOT NULL,
         last_modified TIMESTAMPTZ
       )`
    );
    for await (const page of storage.listObjectsPaginated(1000)) {
      totalObjects += page.length;
      await client.query(
        `INSERT INTO orphan_storage_inventory(key, size, last_modified)
         SELECT * FROM unnest($1::text[], $2::bigint[], $3::timestamptz[])
         ON CONFLICT (key) DO UPDATE
           SET size = EXCLUDED.size, last_modified = EXCLUDED.last_modified`,
        [
          page.map(object => object.key),
          page.map(object => object.size || 0),
          page.map(object => object.lastModified || null),
        ]
      );
    }

    const storageSummary = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(i.size), 0) AS bytes
         FROM orphan_storage_inventory i
        WHERE i.last_modified IS NOT NULL AND i.last_modified <= $1
          AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path = i.key)`,
      [cutoff]
    );
    const storageItems = await client.query(
      `SELECT i.key, i.size, i.last_modified
         FROM orphan_storage_inventory i
        WHERE i.last_modified IS NOT NULL AND i.last_modified <= $1
          AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path = i.key)
        ORDER BY i.key
        LIMIT $2`,
      [cutoff, MAX_REPORTED_PER_CATEGORY]
    );
    const dbSummary = await client.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(f.size), 0) AS bytes
         FROM files f
        WHERE f.type = 'file' AND f.path IS NOT NULL
          AND f.path NOT LIKE '/%' AND f.path !~ '^[A-Za-z]:[\\\\/]'
          AND f.created_at IS NOT NULL AND f.created_at <= $1
          AND NOT EXISTS (SELECT 1 FROM orphan_storage_inventory i WHERE i.key = f.path)`,
      [cutoff]
    );
    const dbItems = await client.query(
      `SELECT f.id, f.name, f.path, f.size, f.mime_type, f.modified, f.created_at, f.deleted_at,
              u.email AS user_email, u.name AS user_name
         FROM files f
         LEFT JOIN users u ON u.id = f.user_id
        WHERE f.type = 'file' AND f.path IS NOT NULL
          AND f.path NOT LIKE '/%' AND f.path !~ '^[A-Za-z]:[\\\\/]'
          AND f.created_at IS NOT NULL AND f.created_at <= $1
          AND NOT EXISTS (SELECT 1 FROM orphan_storage_inventory i WHERE i.key = f.path)
        ORDER BY f.id
        LIMIT $2`,
      [cutoff, MAX_REPORTED_PER_CATEGORY]
    );
    const totals = await client.query(
      `SELECT
         (SELECT COUNT(*)::int FROM files f
           WHERE f.type = 'file' AND f.path IS NOT NULL
             AND f.path NOT LIKE '/%' AND f.path !~ '^[A-Za-z]:[\\\\/]') AS database_rows,
         (SELECT COUNT(*)::int FROM orphan_storage_inventory i
           WHERE (i.last_modified IS NULL OR i.last_modified > $1)
             AND NOT EXISTS (SELECT 1 FROM files f WHERE f.path = i.key))
         +
         (SELECT COUNT(*)::int FROM files f
           WHERE f.type = 'file' AND f.path IS NOT NULL
             AND f.path NOT LIKE '/%' AND f.path !~ '^[A-Za-z]:[\\\\/]'
             AND (f.created_at IS NULL OR f.created_at > $1)
             AND NOT EXISTS (SELECT 1 FROM orphan_storage_inventory i WHERE i.key = f.path)) AS skipped`,
      [cutoff]
    );

    const storageOrphanCount = Number(storageSummary.rows[0].count) || 0;
    const storageOrphanBytes = Number(storageSummary.rows[0].bytes) || 0;
    const dbOrphanCount = Number(dbSummary.rows[0].count) || 0;
    const dbOrphanBytes = Number(dbSummary.rows[0].bytes) || 0;
    const totalRows = Number(totals.rows[0].database_rows) || 0;
    const skippedTooRecent = Number(totals.rows[0].skipped) || 0;
    const storageOrphans = storageItems.rows.map(row => ({
      key: row.key,
      size: Number(row.size) || 0,
      lastModified: row.last_modified ? new Date(row.last_modified).toISOString() : null,
    }));
    const dbOrphans = dbItems.rows.map(row => ({
      id: row.id,
      name: row.name,
      path: row.path,
      size: Number(row.size) || 0,
      mimeType: row.mime_type,
      modified: row.modified ? new Date(row.modified).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
      trashed: Boolean(row.deleted_at),
      ownerEmail: row.user_email || null,
      ownerName: row.user_name || null,
    }));

    logger.info(
      {
        graceMinutes: grace,
        totalObjects,
        totalRows,
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
      driver: 's3',
      totals: {
        storedObjects: totalObjects,
        databaseRows: totalRows,
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
  } finally {
    await client.query('DROP TABLE IF EXISTS orphan_storage_inventory').catch(() => {});
    client.release();
  }
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

  const referenced = keys.length
    ? await pool.query('SELECT path FROM files WHERE path = ANY($1::text[])', [keys])
    : { rows: [] };
  const referencedKeys = new Set(referenced.rows.map(row => row.path));
  const storageResultsByKey = new Map();
  const storageCandidates = keys.filter(key => {
    if (!isStorageKey(key)) {
      storageResultsByKey.set(key, { key, deleted: false, reason: 'Not a valid storage key' });
      return false;
    }
    if (referencedKeys.has(key)) {
      storageResultsByKey.set(key, { key, deleted: false, reason: 'A file now references this object' });
      return false;
    }
    return true;
  });

  let nextStorage = 0;
  const deletableStorageKeys = [];
  await Promise.all(
    Array.from({ length: Math.min(8, storageCandidates.length) }, async () => {
      while (nextStorage < storageCandidates.length) {
        const key = storageCandidates[nextStorage++];
        try {
          const stat = await storage.statObject(key);
          if (!stat) storageResultsByKey.set(key, { key, deleted: false, reason: 'Object no longer exists' });
          else if (!stat.lastModified || stat.lastModified > cutoff) {
            storageResultsByKey.set(key, { key, deleted: false, reason: 'Object was written too recently' });
          } else deletableStorageKeys.push(key);
        } catch (err) {
          logger.error({ err, key }, '[Orphans] Failed to verify storage orphan');
          storageResultsByKey.set(key, { key, deleted: false, reason: err.message || 'Verification failed' });
        }
      }
    })
  );

  if (deletableStorageKeys.length > 0) {
    const rechecked = await pool.query('SELECT path FROM files WHERE path = ANY($1::text[])', [deletableStorageKeys]);
    const nowReferenced = new Set(rechecked.rows.map(row => row.path));
    const safeKeys = deletableStorageKeys.filter(key => {
      if (!nowReferenced.has(key)) return true;
      storageResultsByKey.set(key, { key, deleted: false, reason: 'A file now references this object' });
      return false;
    });
    if (safeKeys.length > 0) {
      const deletion = await storage.deleteObjects(safeKeys);
      const errors = new Map((deletion.errors || []).map(error => [error.Key, error.Message || 'Deletion failed']));
      for (const key of safeKeys) {
        storageResultsByKey.set(
          key,
          errors.has(key) ? { key, deleted: false, reason: errors.get(key) } : { key, deleted: true }
        );
      }
    }
  }
  const storageResults = keys.map(key => storageResultsByKey.get(key));

  const selectedRows = ids.length
    ? await pool.query("SELECT id, path, user_id, created_at FROM files WHERE id = ANY($1::text[]) AND type = 'file'", [
        ids,
      ])
    : { rows: [] };
  const rowsById = new Map(selectedRows.rows.map(row => [row.id, row]));
  const databaseResultsById = new Map();
  const databaseCandidates = ids.filter(id => {
    const row = rowsById.get(id);
    if (!row) {
      databaseResultsById.set(id, { id, deleted: false, reason: 'Row no longer exists' });
      return false;
    }
    if (!isStorageKey(row.path)) {
      databaseResultsById.set(id, { id, deleted: false, reason: 'Row does not map to a storage key' });
      return false;
    }
    if (!row.created_at || new Date(row.created_at) > cutoff) {
      databaseResultsById.set(id, { id, deleted: false, reason: 'Row was created too recently' });
      return false;
    }
    return true;
  });
  let nextDatabase = 0;
  const missingObjectIds = [];
  await Promise.all(
    Array.from({ length: Math.min(8, databaseCandidates.length) }, async () => {
      while (nextDatabase < databaseCandidates.length) {
        const id = databaseCandidates[nextDatabase++];
        const row = rowsById.get(id);
        try {
          if (await storage.exists(row.path)) {
            databaseResultsById.set(id, { id, deleted: false, reason: 'Stored object exists again' });
          } else missingObjectIds.push(id);
        } catch (err) {
          logger.error({ err, fileId: id }, '[Orphans] Failed to verify database orphan');
          databaseResultsById.set(id, { id, deleted: false, reason: err.message || 'Verification failed' });
        }
      }
    })
  );

  const affectedUserIds = new Set();
  if (missingObjectIds.length > 0) {
    const deleted = await pool.query(
      `DELETE FROM files
        WHERE id = ANY($1::text[]) AND type = 'file' AND created_at <= $2
        RETURNING id, user_id`,
      [missingObjectIds, cutoff]
    );
    const deletedIds = new Set(deleted.rows.map(row => row.id));
    for (const row of deleted.rows) affectedUserIds.add(row.user_id);
    for (const id of missingObjectIds) {
      databaseResultsById.set(
        id,
        deletedIds.has(id) ? { id, deleted: true } : { id, deleted: false, reason: 'Row changed during verification' }
      );
    }
  }
  const databaseResults = ids.map(id => databaseResultsById.get(id));

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
