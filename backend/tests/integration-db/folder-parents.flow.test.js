/**
 * Every write that names a parent must land in a live folder of the caller's
 * account. A paste onto a file used to store items under that file, where no
 * client could list them.
 */

import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { processFileOperation } from '../../services/fileOperationWorker.js';
import { createAndLogin, signUpAndLogin } from './helpers/app.js';
import { countRows } from './helpers/factories.js';

function upload(c, { name = 'notes.txt', parentId } = {}) {
  const req = c
    .post('/api/files/upload')
    .attach('file', Buffer.from('hello'), { filename: name, contentType: 'text/plain' });
  if (parentId) req.field('parentId', parentId);
  return req;
}

function uploadBulk(c, names, parentId) {
  const req = c.post('/api/files/upload/bulk');
  for (const name of names) req.attach('files', Buffer.from('x'), { filename: name, contentType: 'text/plain' });
  for (const name of names) {
    req.field('relativePaths', '');
    req.field('clientIds', name);
    req.field('lastModifiedTimes', '');
  }
  if (parentId) req.field('parentId', parentId);
  return req;
}

async function fileId(c, name) {
  expect((await upload(c, { name })).status).toBeLessThan(400);
  const { rows } = await pool.query('SELECT id FROM files WHERE name = $1', [name]);
  return rows[0].id;
}

async function folderId(c, name) {
  const res = await c.post('/api/files/folder').send({ name });
  expect(res.status).toBeLessThan(400);
  return res.body.id || res.body.folder?.id;
}

describe('a file is never a parent', () => {
  it('refuses an upload into a file', async () => {
    const { client: c } = await signUpAndLogin();
    const doc = await fileId(c, 'report.pdf');

    const res = await upload(c, { name: 'pasted.txt', parentId: doc });

    expect(res.status).toBe(404);
    expect(await countRows('files', 'WHERE parent_id = $1', [doc])).toBe(0);
  });

  it('refuses a bulk upload into a file', async () => {
    const { client: c } = await signUpAndLogin();
    const doc = await fileId(c, 'report.pdf');

    const res = await uploadBulk(c, ['a.txt', 'b.txt'], doc);

    expect(res.status).toBe(400);
    expect(await countRows('files', 'WHERE parent_id = $1', [doc])).toBe(0);
  });

  it('refuses a folder inside a file', async () => {
    const { client: c } = await signUpAndLogin();
    const doc = await fileId(c, 'report.pdf');

    const res = await c.post('/api/files/folder').send({ name: 'Nested', parentId: doc });

    expect(res.status).toBe(404);
    expect(await countRows('files', "WHERE type = 'folder'")).toBe(0);
  });

  it('rejects a direct insert under a file at the database', async () => {
    const { client: c, user } = await signUpAndLogin();
    const doc = await fileId(c, 'report.pdf');

    await expect(
      pool.query("INSERT INTO files(id, name, type, user_id, parent_id) VALUES ('raw1', 'x', 'file', $1, $2)", [
        user.id,
        doc,
      ])
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('the parent must be live and owned', () => {
  it('refuses an upload into a trashed folder', async () => {
    const { client: c } = await signUpAndLogin();
    const docs = await folderId(c, 'Docs');
    await pool.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [docs]);

    expect((await upload(c, { parentId: docs })).status).toBe(404);
    expect(await countRows('files', "WHERE type = 'file'")).toBe(0);
  });

  it("refuses an upload into another account's folder", async () => {
    const { client: owner } = await signUpAndLogin();
    const theirs = await folderId(owner, 'Private');
    const { client: intruder } = await createAndLogin();

    expect((await upload(intruder, { parentId: theirs })).status).toBe(404);
    expect(await countRows('files', 'WHERE parent_id = $1', [theirs])).toBe(0);
  });

  it('still uploads into a live folder', async () => {
    const { client: c } = await signUpAndLogin();
    const docs = await folderId(c, 'Docs');

    expect((await upload(c, { parentId: docs })).status).toBeLessThan(400);
    expect(await countRows('files', 'WHERE parent_id = $1', [docs])).toBe(1);
  });

  it('drops a queued copy whose target was trashed before it ran', async () => {
    const { client: c, user } = await signUpAndLogin();
    const doc = await fileId(c, 'report.pdf');
    const docs = await folderId(c, 'Docs');
    await pool.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [docs]);
    const job = { id: randomUUID(), data: { task: 'copy', ids: [doc], userId: user.id, parentId: docs } };

    await expect(processFileOperation(job)).rejects.toMatchObject({ status: 404 });
    expect(await countRows('files', "WHERE type = 'file'")).toBe(1);
  });
});
