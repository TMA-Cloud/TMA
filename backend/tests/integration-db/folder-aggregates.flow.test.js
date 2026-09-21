/**
 * Folder aggregates are the only source of a folder's size and counts, so the
 * numbers the API returns are only as good as the triggers that maintain them.
 *
 * These drive the real endpoints and then ask reconcile_folder_aggregates() —
 * which recomputes from the rows themselves — whether anything drifted. A
 * repair count above zero means a write path stopped maintaining the columns.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { ensureOwner, waitForFileJob } from './helpers/app.js';

/** Recompute from the rows; returns how many folders were stored wrong. */
async function drift(userId) {
  const { rows } = await pool.query('SELECT reconcile_folder_aggregates($1) AS repaired', [userId]);
  return Number(rows[0].repaired) || 0;
}

async function aggregates(folderId) {
  const { rows } = await pool.query(
    `SELECT aggregate_size AS size, aggregate_file_count AS files, aggregate_folder_count AS folders
       FROM files WHERE id = $1`,
    [folderId]
  );
  return { size: Number(rows[0].size), files: rows[0].files, folders: rows[0].folders };
}

const folderId = response => response.body.folder?.id || response.body.id;

async function upload(c, parentId, name, content) {
  const res = await c
    .post('/api/files/upload')
    .field('parentId', parentId)
    .attach('file', Buffer.from(content), { filename: name, contentType: 'text/plain' });
  return res.body.file?.id || res.body.id;
}

describe('folder aggregates', () => {
  it('rolls every descendant up the ancestor chain', async () => {
    const { client: c, user } = await ensureOwner();
    const outer = folderId(await c.post('/api/files/folder').send({ name: 'Outer' }));
    const inner = folderId(await c.post('/api/files/folder').send({ name: 'Inner', parentId: outer }));

    await upload(c, outer, 'shallow.txt', 'a'.repeat(10));
    await upload(c, inner, 'deep.txt', 'b'.repeat(25));

    expect(await aggregates(inner)).toEqual({ size: 25, files: 1, folders: 0 });
    expect(await aggregates(outer)).toEqual({ size: 35, files: 2, folders: 1 });
    expect(await drift(user.id)).toBe(0);
  });

  it('stays exact when a subtree moves between folders', async () => {
    const { client: c, user } = await ensureOwner();
    const source = folderId(await c.post('/api/files/folder').send({ name: 'Source' }));
    const target = folderId(await c.post('/api/files/folder').send({ name: 'Target' }));
    const moving = folderId(await c.post('/api/files/folder').send({ name: 'Moving', parentId: source }));
    await upload(c, moving, 'payload.txt', 'c'.repeat(50));

    expect(await aggregates(source)).toEqual({ size: 50, files: 1, folders: 1 });

    await c.post('/api/files/move').send({ ids: [moving], parentId: target });

    expect(await aggregates(source)).toEqual({ size: 0, files: 0, folders: 0 });
    expect(await aggregates(target)).toEqual({ size: 50, files: 1, folders: 1 });
    expect(await drift(user.id)).toBe(0);
  });

  it('keeps trashed children counted, then drops them on permanent delete', async () => {
    const { client: c, user } = await ensureOwner();
    const parent = folderId(await c.post('/api/files/folder').send({ name: 'Parent' }));
    const doomed = await upload(c, parent, 'doomed.txt', 'd'.repeat(40));

    // A soft delete leaves the row in place, and the listing columns have
    // always included trashed children, so the total must not move yet.
    await c.post('/api/files/delete').send({ ids: [doomed] });
    expect(await aggregates(parent)).toEqual({ size: 40, files: 1, folders: 0 });
    expect(await drift(user.id)).toBe(0);

    const purged = await c.post('/api/files/trash/delete').send({ ids: [doomed] });
    await waitForFileJob(c, purged);

    expect(await aggregates(parent)).toEqual({ size: 0, files: 0, folders: 0 });
    expect(await drift(user.id)).toBe(0);
  });

  it('repairs a folder whose counters were lost, without touching healthy ones', async () => {
    const { client: c, user } = await ensureOwner();
    const parent = folderId(await c.post('/api/files/folder').send({ name: 'Parent' }));
    const sibling = folderId(await c.post('/api/files/folder').send({ name: 'Sibling' }));
    await upload(c, parent, 'payload.txt', 'e'.repeat(60));

    // What a clamped-to-zero delta leaves behind.
    await pool.query('UPDATE files SET aggregate_size = 0, aggregate_file_count = 0 WHERE id = $1', [parent]);

    expect(await drift(user.id)).toBe(1);
    expect(await aggregates(parent)).toEqual({ size: 60, files: 1, folders: 0 });
    expect(await aggregates(sibling)).toEqual({ size: 0, files: 0, folders: 0 });
    expect(await drift(user.id)).toBe(0);
  });
});
