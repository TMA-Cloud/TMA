import path from 'path';
import Cursor from 'pg-cursor';

import pool from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { invalidateAllFileCaches } from '../../utils/cache.js';
import { plaintextSizeToCiphertextSize } from '../../utils/fileEncryption.js';
import { isFilePathEncrypted } from '../../utils/filePath.js';
import storage from '../../utils/storageDriver.js';
import { releaseStorageReservation, reserveStorage } from '../../services/storageReservations.js';

/**
 * Move files to a different parent folder. Name conflicts in the target are
 * resolved by keeping both, as copy and upload do, so a move never leaves two
 * items with the same name side by side.
 */
async function moveFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize hierarchy mutations for this account across API instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
    const filesResult = await client.query(
      `SELECT id, parent_id, type, name FROM files
        WHERE id = ANY($1::text[]) AND user_id = $2
        ORDER BY array_position($1::text[], id)
        FOR UPDATE`,
      [ids, userId]
    );

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

    // Items already in the target stay put, like a paste back into the same folder.
    const moving = filesResult.rows.filter(row => row.parent_id !== parentId);
    const oldParentIds = [...new Set(moving.map(row => row.parent_id))];
    if (moving.length > 0) {
      const names = await allocateTargetNames(client, userId, parentId, moving);
      await client.query(
        `UPDATE files f
            SET parent_id = $1, name = incoming.name
           FROM unnest($2::text[], $3::text[]) AS incoming(id, name)
          WHERE f.id = incoming.id AND f.user_id = $4`,
        [parentId, moving.map(row => row.id), names, userId]
      );
    }
    await client.query('COMMIT');

    await invalidateAllFileCaches(userId, parentId, { includeStats: false, includeStorage: false });
    for (const oldParentId of oldParentIds) {
      await invalidateAllFileCaches(userId, oldParentId, { includeStats: false, includeStorage: false });
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
 * Pick a free name in the target folder for each incoming item, in order.
 * Files and folders are deduplicated against their own type, matching upload.
 * @param {{ id?: string, name: string, type: string }[]} items
 * @returns {Promise<string[]>} one name per item
 */
async function allocateTargetNames(client, userId, parentId, items) {
  const escapeLike = value => value.replace(/([%_\\])/g, '\\$1');
  const occupied = await client.query(
    `WITH requested(idx, desired, pattern, type) AS (
       SELECT * FROM unnest($1::int[], $2::text[], $3::text[], $4::text[])
     )
     SELECT requested.idx, f.name FROM requested JOIN files f
       ON f.user_id = $5 AND f.parent_id IS NOT DISTINCT FROM $6
      AND f.type = requested.type AND f.deleted_at IS NULL
      AND NOT f.id = ANY($7::text[])
      AND (LOWER(f.name) = LOWER(requested.desired) OR LOWER(f.name) LIKE LOWER(requested.pattern) ESCAPE '\\')`,
    [
      items.map((_, i) => i),
      items.map(item => item.name),
      items.map(item => {
        const ext = item.type === 'file' ? path.extname(item.name) : '';
        const base = item.type === 'file' ? path.basename(item.name, ext) : item.name;
        return `${escapeLike(base)} (%)${escapeLike(ext)}`;
      }),
      items.map(item => item.type),
      userId,
      parentId,
      items.map(item => item.id).filter(Boolean),
    ]
  );
  const occupiedByItem = new Map();
  for (const row of occupied.rows) {
    const names = occupiedByItem.get(row.idx) || new Set();
    names.add(row.name.toLocaleLowerCase());
    occupiedByItem.set(row.idx, names);
  }
  const batchOccupied = { file: new Set(), folder: new Set() };
  return items.map((item, i) => {
    const batch = batchOccupied[item.type] || batchOccupied.file;
    const used = new Set([...(occupiedByItem.get(i) || []), ...batch]);
    const name = item.type === 'file' ? allocateUniqueName(item.name, used) : allocateUniqueFolderName(item.name, used);
    batch.add(name.toLocaleLowerCase());
    return name;
  });
}

function allocateUniqueFolderName(desiredName, occupiedNames) {
  if (!occupiedNames.has(desiredName.toLocaleLowerCase())) return desiredName;
  for (let counter = 1; counter <= 10000; counter += 1) {
    const candidate = `${desiredName} (${counter})`;
    if (!occupiedNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error('Too many duplicate names in database');
}

/**
 * Copy files and folders without routing object bytes through this process.
 * The tree is planned with one recursive read, object-store copies happen with
 * bounded concurrency, and the database transaction contains inserts only.
 */
async function copyFiles(ids, parentId = null, userId, { operationId = null } = {}) {
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
    if (operationId) {
      const completed = await client.query(
        `SELECT output FROM file_operation_results
          WHERE job_id = $1 AND user_id = $2 AND task = 'copy'`,
        [operationId, userId]
      );
      if (completed.rows.length > 0) {
        await invalidateAllFileCaches(userId, parentId);
        return completed.rows[0].output?.ids || [];
      }
    }

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
         SELECT tree.*,
                SUBSTRING(MD5(COALESCE($3::text, RANDOM()::text) || ':' || id || ':' || root_order::text), 1, 16)
                  AS new_id
           FROM tree
       )
       SELECT id AS source_id, parent_id AS source_parent_id, root_order, depth,
              new_id, name AS new_name, type, size, mime_type, path AS source_path,
              CASE WHEN type = 'file'
                   THEN new_id || COALESCE(SUBSTRING(name FROM '(\\.[^.]*)$'), '')
                   ELSE NULL END AS new_path,
              NULL::text AS new_parent_id, starred, modified, dek_wrapped, dek_kek_version
         FROM planned`,
      [ids, userId, operationId]
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
    const rootNames = await allocateTargetNames(
      client,
      userId,
      parentId,
      roots.rows.map(row => ({ name: row.new_name, type: row.type }))
    );
    await client.query(
      `UPDATE copy_stage stage SET new_name = incoming.name
         FROM unnest($1::int[], $2::text[]) AS incoming(root_order, name)
        WHERE stage.depth = 0 AND stage.root_order = incoming.root_order`,
      [roots.rows.map(row => row.root_order), rootNames]
    );

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
    const copiedIds = roots.rows.map(entry => entry.new_id);
    if (operationId) {
      await client.query(
        `INSERT INTO file_operation_results(job_id, user_id, task, output)
         VALUES($1, $2, 'copy', $3::jsonb)
         ON CONFLICT (job_id) DO NOTHING`,
        [operationId, userId, JSON.stringify({ ids: copiedIds, count: copiedIds.length })]
      );
    }
    await client.query('COMMIT');
    await invalidateAllFileCaches(userId, parentId);
    return copiedIds;
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
