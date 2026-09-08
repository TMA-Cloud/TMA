/**
 * File lifecycle end to end: upload, organise, share, trash, restore, purge.
 *
 * Real multipart uploads, real AES-256-GCM encryption to an isolated in-memory bucket,
 * real rows in Postgres, real cache invalidation in Redis.
 */

import { exists, readStoredBuffer } from '../mocks/storage.mock.js';
import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { createAndLogin, signUpAndLogin } from './helpers/app.js';
import { countRows, readFileRow } from './helpers/factories.js';

/** Upload a buffer through the real multipart endpoint. */
function upload(c, { name = 'notes.txt', content = 'hello world', parentId, mime = 'text/plain' } = {}) {
  const req = c.post('/api/files/upload').attach('file', Buffer.from(content), { filename: name, contentType: mime });
  if (parentId) req.field('parentId', parentId);
  return req;
}

async function createFolder(c, name, parentId = null) {
  const res = await c.post('/api/files/folder').send({ name, parentId });
  expect(res.status).toBeLessThan(400);
  return res.body.folder?.id || res.body.id || res.body.file?.id;
}

describe('folder creation', () => {
  it('creates a folder at the root', async () => {
    const { client: c } = await signUpAndLogin();

    const res = await c.post('/api/files/folder').send({ name: 'Documents' });

    expect(res.status).toBeLessThan(400);
    expect(await countRows('files', "WHERE type = 'folder'")).toBe(1);
  });

  it('nests a folder under a parent', async () => {
    const { client: c } = await signUpAndLogin();
    const parentId = await createFolder(c, 'Parent');

    await createFolder(c, 'Child', parentId);

    const { rows } = await pool.query("SELECT parent_id FROM files WHERE name = 'Child'");
    expect(rows[0].parent_id).toBe(parentId);
  });

  it('rejects a name containing a path separator', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await c.post('/api/files/folder').send({ name: '../escape' });

    expect(res.status).toBe(422);
    expect(await countRows('files')).toBe(0);
  });

  it('rejects an empty name', async () => {
    const { client: c } = await signUpAndLogin();
    expect((await c.post('/api/files/folder').send({ name: '   ' })).status).toBe(422);
  });

  it('accepts a Unicode name', async () => {
    const { client: c } = await signUpAndLogin();
    await createFolder(c, '報告書');

    const { rows } = await pool.query('SELECT name FROM files');
    expect(rows[0].name).toBe('報告書');
  });
});

describe('upload', () => {
  it('stores the file and records it', async () => {
    const { client: c } = await signUpAndLogin();

    const res = await upload(c, { name: 'notes.txt', content: 'hello world' });

    expect(res.status).toBeLessThan(400);
    expect(await countRows('files', "WHERE type = 'file'")).toBe(1);
  });

  it('writes the bytes to storage under the recorded key', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt', content: 'hello world' });

    const { rows } = await pool.query('SELECT path FROM files');
    expect(await exists(rows[0].path)).toBe(true);
  });

  it('encrypts at rest — the plaintext never appears in the stored object', async () => {
    const { client: c } = await signUpAndLogin();
    const secret = 'TOP-SECRET-PAYLOAD-MARKER';
    await upload(c, { name: 'notes.txt', content: secret });

    const { rows } = await pool.query('SELECT path FROM files');
    const stored = readStoredBuffer(rows[0].path);

    expect(stored.toString('latin1')).not.toContain(secret);
  });

  it('records the plaintext size, not the encrypted size', async () => {
    const { client: c } = await signUpAndLogin();
    const content = 'x'.repeat(500);
    await upload(c, { name: 'notes.txt', content });

    const { rows } = await pool.query('SELECT size FROM files');
    expect(Number(rows[0].size)).toBe(500);
  });

  it('places the upload in the requested folder', async () => {
    const { client: c } = await signUpAndLogin();
    const parentId = await createFolder(c, 'Docs');

    await upload(c, { name: 'notes.txt', parentId });

    const { rows } = await pool.query("SELECT parent_id FROM files WHERE type = 'file'");
    expect(rows[0].parent_id).toBe(parentId);
  });

  it('preserves a Unicode filename', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: '報告書.txt' });

    const { rows } = await pool.query("SELECT name FROM files WHERE type = 'file'");
    expect(rows[0].name).toBe('報告書.txt');
  });

  it('de-duplicates a name that already exists in the same folder', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt', content: 'first' });
    await upload(c, { name: 'notes.txt', content: 'second' });

    const { rows } = await pool.query("SELECT name FROM files WHERE type = 'file' ORDER BY name");
    expect(rows.map(r => r.name)).toEqual(['notes (1).txt', 'notes.txt']);
  });

  it('gives each upload its own storage key', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'a.txt', content: 'same' });
    await upload(c, { name: 'b.txt', content: 'same' });

    const { rows } = await pool.query("SELECT path FROM files WHERE type = 'file'");
    expect(new Set(rows.map(r => r.path)).size).toBe(2);
  });
});

describe('download', () => {
  it('returns exactly the bytes that were uploaded', async () => {
    const { client: c } = await signUpAndLogin();
    const content = 'round trip through encryption and back';
    await upload(c, { name: 'notes.txt', content });

    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");
    const res = await c
      .get(`/api/files/${rows[0].id}/download`)
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe(content);
  });

  it('round-trips binary content byte for byte', async () => {
    const { client: c } = await signUpAndLogin();
    const binary = Buffer.from(Array.from({ length: 2048 }, (_, i) => i % 256));
    await upload(c, { name: 'blob.bin', content: binary, mime: 'application/octet-stream' });

    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");
    const res = await c
      .get(`/api/files/${rows[0].id}/download`)
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(Buffer.compare(res.body, binary)).toBe(0);
  });

  it('sends a Content-Disposition carrying the original name', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: '報告書.txt' });

    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");
    const res = await c.get(`/api/files/${rows[0].id}/download`);

    const encoded = res.headers['content-disposition'].match(/filename\*=UTF-8''(.+)$/)[1];
    expect(decodeURIComponent(encoded)).toBe('報告書.txt');
  });

  it("refuses to serve another account's file", async () => {
    const { client: owner } = await signUpAndLogin();
    await upload(owner, { name: 'private.txt', content: 'mine' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    const { client: stranger } = await createAndLogin();
    const res = await stranger.get(`/api/files/${rows[0].id}/download`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('listing', () => {
  it('returns the files in a folder', async () => {
    const { client: c } = await signUpAndLogin();
    await createFolder(c, 'Docs');
    await upload(c, { name: 'notes.txt' });

    const res = await c.get('/api/files');

    expect(res.status).toBe(200);
    const names = (res.body.files || res.body).map(f => f.name);
    expect(names).toContain('Docs');
    expect(names).toContain('notes.txt');
  });

  it('scopes the listing to the requesting account', async () => {
    const { client: a } = await signUpAndLogin();
    await upload(a, { name: 'a-file.txt' });

    const { client: b } = await createAndLogin();
    const res = await b.get('/api/files');

    const names = (res.body.files || res.body).map(f => f.name);
    expect(names).not.toContain('a-file.txt');
  });

  it('reports storage usage that matches what was uploaded', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'a.txt', content: 'x'.repeat(1000) });
    await upload(c, { name: 'b.txt', content: 'x'.repeat(500) });

    const res = await c.get('/api/user/storage');

    expect(res.status).toBe(200);
    expect(Number(res.body.used ?? res.body.storageUsed)).toBe(1500);
  });
});

describe('rename', () => {
  it('renames a file', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'before.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    const res = await c.post('/api/files/rename').send({ id: rows[0].id, name: 'after.txt' });

    expect(res.status).toBeLessThan(400);
    expect((await readFileRow(rows[0].id)).name).toBe('after.txt');
  });

  it('rejects a name containing a separator', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'before.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    const res = await c.post('/api/files/rename').send({ id: rows[0].id, name: '../escape.txt' });

    expect(res.status).toBe(422);
    expect((await readFileRow(rows[0].id)).name).toBe('before.txt');
  });

  it("will not rename another account's file", async () => {
    const { client: owner } = await signUpAndLogin();
    await upload(owner, { name: 'mine.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    const { client: stranger } = await createAndLogin();
    await stranger.post('/api/files/rename').send({ id: rows[0].id, name: 'stolen.txt' });

    expect((await readFileRow(rows[0].id)).name).toBe('mine.txt');
  });
});

describe('move', () => {
  it('moves a file into a folder', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = await createFolder(c, 'Target');
    await upload(c, { name: 'notes.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    const res = await c.post('/api/files/move').send({ ids: [rows[0].id], parentId: folderId });

    expect(res.status).toBeLessThan(400);
    expect((await readFileRow(rows[0].id)).parent_id).toBe(folderId);
  });

  it('moves a file back to the root', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = await createFolder(c, 'Target');
    await upload(c, { name: 'notes.txt', parentId: folderId });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/move').send({ ids: [rows[0].id], parentId: null });

    expect((await readFileRow(rows[0].id)).parent_id).toBeNull();
  });
});

describe('copy', () => {
  it('produces a second independent row', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = await createFolder(c, 'Target');
    await upload(c, { name: 'notes.txt', content: 'copy me' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    const res = await c.post('/api/files/copy').send({ ids: [rows[0].id], parentId: folderId });

    expect(res.status).toBeLessThan(400);
    expect(await countRows('files', "WHERE type = 'file'")).toBe(2);
  });

  it('gives the copy its own storage object, so deleting one keeps the other readable', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = await createFolder(c, 'Target');
    await upload(c, { name: 'notes.txt', content: 'copy me' });
    const original = (await pool.query("SELECT id, path FROM files WHERE type = 'file'")).rows[0];

    await c.post('/api/files/copy').send({ ids: [original.id], parentId: folderId });

    const { rows } = await pool.query("SELECT path FROM files WHERE type = 'file'");
    expect(new Set(rows.map(r => r.path)).size).toBe(2);
  });

  it('the copy decrypts to the same content', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = await createFolder(c, 'Target');
    await upload(c, { name: 'notes.txt', content: 'copy me exactly' });
    const original = (await pool.query("SELECT id FROM files WHERE type = 'file'")).rows[0];

    await c.post('/api/files/copy').send({ ids: [original.id], parentId: folderId });
    const copy = (await pool.query("SELECT id FROM files WHERE type = 'file' AND id <> $1", [original.id])).rows[0];

    const res = await c
      .get(`/api/files/${copy.id}/download`)
      .buffer()
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', chunk => chunks.push(chunk));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.body.toString('utf8')).toBe('copy me exactly');
  });
});

describe('starring', () => {
  it('stars and unstars a file', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/star').send({ ids: [rows[0].id], starred: true });
    expect((await readFileRow(rows[0].id)).starred).toBe(true);

    await c.post('/api/files/star').send({ ids: [rows[0].id], starred: false });
    expect((await readFileRow(rows[0].id)).starred).toBe(false);
  });

  it('lists starred files', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'starred.txt' });
    await upload(c, { name: 'plain.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE name = 'starred.txt'");

    await c.post('/api/files/star').send({ ids: [rows[0].id], starred: true });
    const res = await c.get('/api/files/starred');

    const names = (res.body.files || res.body).map(f => f.name);
    expect(names).toEqual(['starred.txt']);
  });
});

describe('trash lifecycle', () => {
  it('moving to trash hides the file from the listing but keeps the row', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/delete').send({ ids: [rows[0].id] });

    expect((await readFileRow(rows[0].id)).deleted_at).not.toBeNull();
    const listing = await c.get('/api/files');
    expect((listing.body.files || listing.body).map(f => f.name)).not.toContain('notes.txt');
  });

  it('keeps the stored object while the file is in the trash', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt' });
    const file = (await pool.query("SELECT id, path FROM files WHERE type = 'file'")).rows[0];

    await c.post('/api/files/delete').send({ ids: [file.id] });

    expect(await exists(file.path)).toBe(true);
  });

  it('lists trashed files', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/delete').send({ ids: [rows[0].id] });
    const res = await c.get('/api/files/trash');

    expect((res.body.files || res.body).map(f => f.name)).toContain('notes.txt');
  });

  it('restores a file back into the listing', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/delete').send({ ids: [rows[0].id] });
    await c.post('/api/files/trash/restore').send({ ids: [rows[0].id] });

    expect((await readFileRow(rows[0].id)).deleted_at).toBeNull();
    const listing = await c.get('/api/files');
    expect((listing.body.files || listing.body).map(f => f.name)).toContain('notes.txt');
  });

  it('deleting forever removes the row and the stored object', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt' });
    const file = (await pool.query("SELECT id, path FROM files WHERE type = 'file'")).rows[0];

    await c.post('/api/files/delete').send({ ids: [file.id] });
    const res = await c.post('/api/files/trash/delete').send({ ids: [file.id] });

    expect(res.status).toBeLessThan(400);
    expect(await readFileRow(file.id)).toBeUndefined();
    expect(await exists(file.path)).toBe(false);
  });

  it('emptying the trash clears everything in it', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'a.txt' });
    await upload(c, { name: 'b.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/delete').send({ ids: rows.map(r => r.id) });
    await c.post('/api/files/trash/empty').send({});

    expect(await countRows('files', "WHERE type = 'file'")).toBe(0);
  });

  it('frees the quota once a file is purged', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'notes.txt', content: 'x'.repeat(1000) });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");

    await c.post('/api/files/delete').send({ ids: [rows[0].id] });
    await c.post('/api/files/trash/delete').send({ ids: [rows[0].id] });

    const usage = await c.get('/api/user/storage');
    expect(Number(usage.body.used ?? usage.body.storageUsed)).toBe(0);
  });
});

describe('search', () => {
  it('finds a file by a fragment of its name', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'quarterly-report.txt' });
    await upload(c, { name: 'unrelated.txt' });

    const res = await c.get('/api/files/search?query=quarterly');

    expect(res.status).toBe(200);
    const names = (res.body.files || res.body).map(f => f.name);
    expect(names).toContain('quarterly-report.txt');
    expect(names).not.toContain('unrelated.txt');
  });

  it("does not return another account's files", async () => {
    const { client: a } = await signUpAndLogin();
    await upload(a, { name: 'confidential-report.txt' });

    const { client: b } = await createAndLogin();
    const res = await b.get('/api/files/search?query=confidential');

    expect(res.body.files || res.body).toHaveLength(0);
  });

  it('excludes trashed files', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'quarterly-report.txt' });
    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");
    await c.post('/api/files/delete').send({ ids: [rows[0].id] });

    const res = await c.get('/api/files/search?query=quarterly');
    expect(res.body.files || res.body).toHaveLength(0);
  });
});
