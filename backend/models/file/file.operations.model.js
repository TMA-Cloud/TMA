import path from 'path';
import Cursor from 'pg-cursor';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { invalidateAllFileCaches } from '../../utils/cache.js';
import { plaintextSizeToCiphertextSize } from '../../utils/fileEncryption.js';
import { isFilePathEncrypted } from '../../utils/filePath.js';
import storage from '../../utils/storageDriver.js';
import { releaseStorageReservation, reserveStorage } from '../../services/storageReservations.js';

/** Move files to a different parent folder. */
async function moveFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize hierarchy mutations for this account across API instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
    const filesResult = await client.query(
      'SELECT id, parent_id, path, type, name FROM files WHERE id = ANY($1::text[]) AND user_id = $2 FOR UPDATE',
      [ids, userId]
    );
    const oldParentIds = [...new Set(filesResult.rows.map(row => row.parent_id))];

    if (parentId) {
      const target = await client.query(
        `SELECT id FROM files
          WHERE id = $1 AND user_id = $2 AND type = 'folder' AND deleted_at IS NULL
          FOR UPDATE`,
        [parentId, userId]
      );
      if (target.rows.length === 0) throw new Error('Target folder not found');

      const cycle = await client.query(
        `WITH RECURSIVE descendants(id, visited) AS (
           SELECT id, ARRAY[id] FROM files WHERE id = ANY($1::text[]) AND user_id = $2
           UNION ALL
           SELECT child.id, descendants.visited || child.id
             FROM files child
             JOIN descendants ON child.parent_id = descendants.id
            WHERE child.user_id = $2 AND NOT child.id = ANY(descendants.visited)
         )
         SELECT 1 FROM descendants WHERE id = $3 LIMIT 1`,
        [ids, userId, parentId]
      );
      if (cycle.rows.length > 0) throw new Error('A folder cannot be moved into itself or one of its descendants');
    }

    await client.query(
      `UPDATE files f
          SET parent_id = $1
         FROM unnest($2::text[]) AS selected(id)
        WHERE f.id = selected.id AND f.user_id = $3`,
      [parentId, ids, userId]
    );
    await client.query('COMMIT');

    await invalidateAllFileCaches(userId, parentId, { includeStats: false, includeStorage: false });
    for (const oldParentId of oldParentIds) {
      if (oldParentId !== parentId) {
        await invalidateAllFileCaches(userId, oldParentId, { includeStats: false, includeStorage: false });
      }
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function allocateUniqueName(desiredName, occupiedNames) {
  const normalized = desiredName.toLocaleLowerCase();
  if (!occupiedNames.has(normalized)) {
    occupiedNames.add(normalized);
    return desiredName;
  }
  const ext = path.extname(desiredName);
  const baseName = path.basename(desiredName, ext);
  for (let counter = 1; counter <= 10000; counter += 1) {
    const candidate = `${baseName} (${counter})${ext}`;
    if (!occupiedNames.has(candidate.toLocaleLowerCase())) {
      occupiedNames.add(candidate.toLocaleLowerCase());
      return candidate;
    }
  }
  throw new Error('Too many duplicate names in database');
}

/**
 * Copy files and folders without routing object bytes through this process.
 * The tree is planned with one recursive read, object-store copies happen with
 * bounded concurrency, and the database transaction contains inserts only.
 */
async function copyFiles(ids, parentId = null, userId) {
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const client = await pool.connect();
  let reservationId = null;
  let stageCreated = false;
  let objectsCopied = false;

  const cleanupObjects = async () => {
    if (!stageCreated) return;
    let after = '';
    for (;;) {
      const result = await client.query(
        `SELECT new_path FROM copy_stage
          WHERE type = 'file' AND new_path > $1
          ORDER BY new_path LIMIT 1000`,
        [after]
      );
      if (result.rows.length === 0) return;
      await storage.deleteObjects(result.rows.map(row => row.new_path)).catch(() => undefined);
      after = result.rows.at(-1).new_path;
    }
  };

  try {
    await client.query(
      `CREATE TEMP TABLE copy_stage ON COMMIT PRESERVE ROWS AS
       WITH RECURSIVE tree AS (
         SELECT f.*, roots.ordinality::integer AS root_order, 0 AS depth,
                ARRAY[f.id]::text[] AS ancestors
           FROM unnest($1::text[]) WITH ORDINALITY AS roots(id, ordinality)
           JOIN files f ON f.id = roots.id
          WHERE f.user_id = $2 AND f.deleted_at IS NULL
         UNION ALL
         SELECT child.*, tree.root_order, tree.depth + 1, tree.ancestors || child.id
           FROM files child JOIN tree ON child.parent_id = tree.id
          WHERE child.user_id = $2 AND child.deleted_at IS NULL AND NOT child.id = ANY(tree.ancestors)
       ), planned AS (
         SELECT tree.*, SUBSTRING(MD5(RANDOM()::text || id || root_order::text), 1, 16) AS new_id
           FROM tree
       )
       SELECT id AS source_id, parent_id AS source_parent_id, root_order, depth,
              new_id, name AS new_name, type, size, mime_type, path AS source_path,
              CASE WHEN type = 'file'
                   THEN new_id || COALESCE(SUBSTRING(name FROM '(\\.[^.]*)$'), '')
                   ELSE NULL END AS new_path,
              NULL::text AS new_parent_id, starred, modified, dek_wrapped, dek_kek_version
         FROM planned`,
      [ids, userId]
    );
    stageCreated = true;
    const countResult = await client.query('SELECT COUNT(*)::integer AS count FROM copy_stage');
    if (countResult.rows[0].count === 0) return [];
    await client.query('CREATE INDEX copy_stage_parent_idx ON copy_stage(root_order, source_parent_id)');
    await client.query(
      `UPDATE copy_stage child
          SET new_parent_id = CASE WHEN child.depth = 0 THEN $1 ELSE parent.new_id END
         FROM copy_stage parent
        WHERE child.depth > 0 AND parent.root_order = child.root_order
          AND parent.source_id = child.source_parent_id`,
      [parentId]
    );
    await client.query('UPDATE copy_stage SET new_parent_id = $1 WHERE depth = 0', [parentId]);

    const roots = await client.query(
      'SELECT root_order, source_id, new_id, new_name, type FROM copy_stage WHERE depth = 0 ORDER BY root_order'
    );
    const requestedFiles = roots.rows.filter(row => row.type === 'file');
    if (requestedFiles.length > 0) {
      const occupied = await client.query(
        `WITH requested(idx, desired, pattern) AS (SELECT * FROM unnest($1::int[], $2::text[], $3::text[]))
         SELECT requested.idx, f.name FROM requested JOIN files f
           ON f.user_id = $4 AND f.parent_id IS NOT DISTINCT FROM $5
          AND f.type = 'file' AND f.deleted_at IS NULL
          AND (f.name = requested.desired OR f.name LIKE requested.pattern ESCAPE '\\')`,
        [
          requestedFiles.map(row => row.root_order),
          requestedFiles.map(row => row.new_name),
          requestedFiles.map(row => {
            const ext = path.extname(row.new_name);
            const base = path.basename(row.new_name, ext);
            const escapeLike = value => value.replace(/([%_\\])/g, '\\$1');
            return `${escapeLike(base)} (%)${escapeLike(ext)}`;
          }),
          userId,
          parentId,
        ]
      );
      const occupiedByRoot = new Map();
      for (const row of occupied.rows) {
        const names = occupiedByRoot.get(row.idx) || new Set();
        names.add(row.name.toLocaleLowerCase());
        occupiedByRoot.set(row.idx, names);
      }
      const batchOccupied = new Set();
      const rootOrders = [];
      const names = [];
      for (const root of requestedFiles) {
        const used = new Set([...(occupiedByRoot.get(root.root_order) || []), ...batchOccupied]);
        const name = allocateUniqueName(root.new_name, used);
        batchOccupied.add(name.toLocaleLowerCase());
        rootOrders.push(root.root_order);
        names.push(name);
      }
      await client.query(
        `UPDATE copy_stage stage SET new_name = incoming.name
           FROM unnest($1::int[], $2::text[]) AS incoming(root_order, name)
          WHERE stage.depth = 0 AND stage.root_order = incoming.root_order`,
        [rootOrders, names]
      );
    }

    const bytesResult = await client.query(
      "SELECT COALESCE(SUM(size), 0)::bigint AS bytes FROM copy_stage WHERE type = 'file'"
    );
    reservationId = await reserveStorage(userId, Number(bytesResult.rows[0].bytes) || 0, 'file-copy');

    const cursor = client.query(
      new Cursor(
        `SELECT source_id, source_path, new_path, size
           FROM copy_stage WHERE type = 'file' ORDER BY new_path`
      )
    );
    try {
      for (;;) {
        const rows = await cursor.read(200);
        if (rows.length === 0) break;
        let next = 0;
        await Promise.all(
          Array.from({ length: Math.min(4, rows.length) }, async () => {
            for (;;) {
              const index = next++;
              if (index >= rows.length) return;
              const entry = rows[index];
              if (!entry.source_path) throw new Error(`Source object path is missing for ${entry.source_id}`);
              const sourceSize = isFilePathEncrypted(entry.source_path)
                ? plaintextSizeToCiphertextSize(Number(entry.size) || 0)
                : Number(entry.size) || 0;
              await storage.copyObject(entry.source_path, entry.new_path, sourceSize);
            }
          })
        );
      }
      objectsCopied = true;
    } finally {
      await cursor.close().catch(() => undefined);
    }

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO files
         (id, name, type, size, mime_type, path, parent_id, user_id,
          starred, shared, modified, dek_wrapped, dek_kek_version)
       SELECT new_id, new_name, type, size, mime_type, new_path, new_parent_id, $1,
              starred, FALSE, modified,
              CASE WHEN type = 'file' THEN dek_wrapped ELSE NULL END,
              CASE WHEN type = 'file' THEN dek_kek_version ELSE NULL END
         FROM copy_stage`,
      [userId]
    );
    await releaseStorageReservation(reservationId, client);
    await client.query('COMMIT');
    await invalidateAllFileCaches(userId, parentId);
    return roots.rows.map(entry => entry.new_id);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await releaseStorageReservation(reservationId).catch(() => undefined);
    if (stageCreated && (objectsCopied || reservationId)) await cleanupObjects();
    logger.error({ err: error }, 'File copy operation failed');
    throw error;
  } finally {
    if (stageCreated) await client.query('DROP TABLE IF EXISTS copy_stage').catch(() => undefined);
    client.release();
  }
}

export { moveFiles, copyFiles };
