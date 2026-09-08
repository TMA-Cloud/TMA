/**
 * Trash retention and restore behaviour, against the documented contract.
 *
 * The wiki (User → Trash & Restore, Concepts → File System) promises three
 * things a database is needed to prove: trash still occupies quota, restoring
 * an item whose folder is gone puts it at the root, and the background job
 * clears items after 15 days.
 */

import { exists } from '../mocks/storage.mock.js';
import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { cleanupExpiredTrash } from '../../models/file/file.cleanup.model.js';
import { ensureOwner } from './helpers/app.js';
import { countRows, readFileRow } from './helpers/factories.js';

function upload(c, { name = 'notes.txt', bytes = 1000, parentId } = {}) {
  const req = c
    .post('/api/files/upload')
    .attach('file', Buffer.alloc(bytes, 0x41), { filename: name, contentType: 'text/plain' });
  if (parentId) req.field('parentId', parentId);
  return req;
}

async function fileIdByName(name) {
  const { rows } = await pool.query('SELECT id FROM files WHERE name = $1', [name]);
  return rows[0]?.id;
}

/** Backdate a trashed row so the retention job considers it expired. */
async function backdateTrash(fileId, days) {
  await pool.query(`UPDATE files SET deleted_at = NOW() - INTERVAL '${days} days' WHERE id = $1`, [fileId]);
}

const usedBytes = async c => {
  const res = await c.get('/api/user/storage');
  return Number(res.body.used ?? res.body.storageUsed);
};

describe('trash still occupies quota', () => {
  it('a trashed file keeps counting against storage usage', async () => {
    const { client: c } = await ensureOwner();
    await upload(c, { bytes: 1000 });
    const fileId = await fileIdByName('notes.txt');

    await c.post('/api/files/delete').send({ ids: [fileId] });

    expect(await usedBytes(c)).toBe(1000);
  });

  it('a trashed file still blocks an upload that would exceed the quota', async () => {
    const { client: c, user } = await ensureOwner();
    await pool.query('UPDATE users SET storage_limit = $1 WHERE id = $2', [5000, user.id]);

    await upload(c, { name: 'a.txt', bytes: 4000 });
    await c.post('/api/files/delete').send({ ids: [await fileIdByName('a.txt')] });

    // Space is only reclaimed by emptying the trash, not by using it.
    expect((await upload(c, { name: 'b.txt', bytes: 4000 })).status).toBe(413);
  });

  it('purging from the trash is what frees the space', async () => {
    const { client: c } = await ensureOwner();
    await upload(c, { bytes: 1000 });
    const fileId = await fileIdByName('notes.txt');

    await c.post('/api/files/delete').send({ ids: [fileId] });
    await c.post('/api/files/trash/delete').send({ ids: [fileId] });

    expect(await usedBytes(c)).toBe(0);
  });
});

describe('restore location', () => {
  it('puts the file back in its original folder', async () => {
    const { client: c } = await ensureOwner();
    const folder = await c.post('/api/files/folder').send({ name: 'Docs' });
    const folderId = folder.body.folder?.id || folder.body.id;
    await upload(c, { name: 'notes.txt', parentId: folderId });
    const fileId = await fileIdByName('notes.txt');

    await c.post('/api/files/delete').send({ ids: [fileId] });
    await c.post('/api/files/trash/restore').send({ ids: [fileId] });

    expect((await readFileRow(fileId)).parent_id).toBe(folderId);
  });

  it('falls back to the root when the original folder is itself still in the trash', async () => {
    const { client: c } = await ensureOwner();
    const folder = await c.post('/api/files/folder').send({ name: 'Docs' });
    const folderId = folder.body.folder?.id || folder.body.id;
    await upload(c, { name: 'notes.txt', parentId: folderId });
    const fileId = await fileIdByName('notes.txt');

    // Trash the folder and its contents, then restore only the file. Its
    // parent is still deleted, so there is nowhere to put it back.
    await c.post('/api/files/delete').send({ ids: [folderId] });
    const res = await c.post('/api/files/trash/restore').send({ ids: [fileId] });

    expect(res.status).toBeLessThan(400);
    expect((await readFileRow(fileId)).parent_id).toBeNull();
    expect((await readFileRow(fileId)).deleted_at).toBeNull();
  });

  it('a row can never be hard-deleted out from under its children', async () => {
    // The foreign key is what makes "restore to root" a soft-delete concern
    // only: a folder with children cannot simply vanish from the table.
    const { client: c } = await ensureOwner();
    const folder = await c.post('/api/files/folder').send({ name: 'Docs' });
    const folderId = folder.body.folder?.id || folder.body.id;
    await upload(c, { name: 'notes.txt', parentId: folderId });

    await expect(pool.query('DELETE FROM files WHERE id = $1', [folderId])).rejects.toThrow(
      /violates foreign key constraint/
    );
  });

  it('restores a folder and its contents together', async () => {
    const { client: c } = await ensureOwner();
    const folder = await c.post('/api/files/folder').send({ name: 'Docs' });
    const folderId = folder.body.folder?.id || folder.body.id;
    await upload(c, { name: 'inside.txt', parentId: folderId });

    await c.post('/api/files/delete').send({ ids: [folderId] });
    await c.post('/api/files/trash/restore').send({ ids: [folderId] });

    const listing = await c.get('/api/files');
    expect((listing.body.files || listing.body).map(f => f.name)).toContain('Docs');
    expect((await readFileRow(await fileIdByName('inside.txt'))).deleted_at).toBeNull();
  });
});

describe('15-day retention job', () => {
  it('removes an item that has been in the trash longer than 15 days', async () => {
    const { client: c } = await ensureOwner();
    await upload(c);
    const fileId = await fileIdByName('notes.txt');
    await c.post('/api/files/delete').send({ ids: [fileId] });
    await backdateTrash(fileId, 16);

    await cleanupExpiredTrash();

    expect(await readFileRow(fileId)).toBeUndefined();
  });

  it('deletes the stored object as well as the row', async () => {
    const { client: c } = await ensureOwner();
    await upload(c);
    const fileId = await fileIdByName('notes.txt');
    const { path: storageKey } = await readFileRow(fileId);
    await c.post('/api/files/delete').send({ ids: [fileId] });
    await backdateTrash(fileId, 16);

    await cleanupExpiredTrash();

    expect(await exists(storageKey)).toBe(false);
  });

  it('leaves an item that is still inside the window', async () => {
    const { client: c } = await ensureOwner();
    await upload(c);
    const fileId = await fileIdByName('notes.txt');
    await c.post('/api/files/delete').send({ ids: [fileId] });
    await backdateTrash(fileId, 14);

    await cleanupExpiredTrash();

    expect(await readFileRow(fileId)).toBeDefined();
  });

  it('never touches a file that is not in the trash', async () => {
    const { client: c } = await ensureOwner();
    await upload(c);

    await cleanupExpiredTrash();

    expect(await countRows('files')).toBe(1);
  });

  it('frees the quota it reclaims', async () => {
    const { client: c } = await ensureOwner();
    await upload(c, { bytes: 1000 });
    const fileId = await fileIdByName('notes.txt');
    await c.post('/api/files/delete').send({ ids: [fileId] });
    await backdateTrash(fileId, 16);

    await cleanupExpiredTrash();

    expect(await usedBytes(c)).toBe(0);
  });

  it('is safe to run when the trash is empty', async () => {
    await ensureOwner();
    await expect(cleanupExpiredTrash()).resolves.not.toThrow();
  });

  it('is safe to run twice', async () => {
    const { client: c } = await ensureOwner();
    await upload(c);
    const fileId = await fileIdByName('notes.txt');
    await c.post('/api/files/delete').send({ ids: [fileId] });
    await backdateTrash(fileId, 16);

    await cleanupExpiredTrash();
    await expect(cleanupExpiredTrash()).resolves.not.toThrow();
  });
});
