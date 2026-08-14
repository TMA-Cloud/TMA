/**
 * Last-access tracking end to end, against real rows.
 *
 * The interesting claims are about what does *not* happen: a listing must not
 * restamp the files it lists, a re-read inside the suppression window must not
 * write at all, and none of it may disturb `modified`.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { flushAccessTimes, resetAccessTracker } from '../../services/accessTracker.js';
import { signUpAndLogin } from './helpers/app.js';

/** Upload a buffer through the real multipart endpoint. */
function upload(c, { name = 'notes.txt', content = 'hello world', parentId } = {}) {
  const req = c.post('/api/files/upload').attach('file', Buffer.from(content), {
    filename: name,
    contentType: 'text/plain',
  });
  if (parentId) req.field('parentId', parentId);
  return req;
}

async function timestamps(id) {
  const { rows } = await pool.query('SELECT accessed_at, modified FROM files WHERE id = $1', [id]);
  return rows[0];
}

/** Backdate a row so a fresh access is unambiguously newer. */
async function backdate(id, interval = '1 day') {
  await pool.query(`UPDATE files SET accessed_at = NOW() - INTERVAL '${interval}' WHERE id = $1`, [id]);
}

beforeEach(() => {
  // The tracker's buffer and suppression windows live in module state, which
  // outlives a single test.
  resetAccessTracker();
});

describe('upload', () => {
  it('stamps a new file as accessed, the way a freshly written file reads on Windows', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await upload(c);

    const { accessed_at: accessedAt } = await timestamps(res.body.id ?? res.body.file?.id);
    expect(accessedAt).toBeInstanceOf(Date);
    expect(Date.now() - accessedAt.getTime()).toBeLessThan(60_000);
  });
});

describe('downloading a file', () => {
  it('moves accessed_at forward', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;
    await backdate(id);
    const before = await timestamps(id);

    await c.get(`/api/files/${id}/download`);
    await flushAccessTimes();

    const after = await timestamps(id);
    expect(after.accessed_at.getTime()).toBeGreaterThan(before.accessed_at.getTime());
  });

  it('leaves modified alone, or sorting by it would mean sorting by who browsed last', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;
    await backdate(id);
    const before = await timestamps(id);

    await c.get(`/api/files/${id}/download`);
    await flushAccessTimes();

    const after = await timestamps(id);
    expect(after.modified.getTime()).toBe(before.modified.getTime());
  });

  it('writes nothing on a second read inside the suppression window', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;

    await c.get(`/api/files/${id}/download`);
    await flushAccessTimes();
    const first = await timestamps(id);

    // Backdating proves the point: if the repeat read wrote anything at all,
    // the row would climb back to now.
    await backdate(id);
    await c.get(`/api/files/${id}/download`);
    await flushAccessTimes();

    const second = await timestamps(id);
    expect(second.accessed_at.getTime()).toBeLessThan(first.accessed_at.getTime());
  });
});

describe('listing a folder', () => {
  it('stamps the folder itself', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = (await c.post('/api/files/folder').send({ name: 'Reports' })).body.id;
    await backdate(folderId);
    const before = await timestamps(folderId);

    await c.get('/api/files').query({ parentId: folderId });
    await flushAccessTimes();

    const after = await timestamps(folderId);
    expect(after.accessed_at.getTime()).toBeGreaterThan(before.accessed_at.getTime());
  });

  it('does not touch the files inside it', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = (await c.post('/api/files/folder').send({ name: 'Reports' })).body.id;
    const fileId = (await upload(c, { parentId: folderId })).body.id;
    await backdate(fileId);
    const before = await timestamps(fileId);

    await c.get('/api/files').query({ parentId: folderId });
    await flushAccessTimes();

    const after = await timestamps(fileId);
    expect(after.accessed_at.getTime()).toBe(before.accessed_at.getTime());
  });
});

describe('downloading a folder', () => {
  it('counts as reading everything the archive pulls in', async () => {
    const { client: c } = await signUpAndLogin();
    const folderId = (await c.post('/api/files/folder').send({ name: 'Reports' })).body.id;
    const fileId = (await upload(c, { parentId: folderId })).body.id;
    await backdate(fileId);
    const before = await timestamps(fileId);

    await c.get(`/api/files/${folderId}/download`);
    await flushAccessTimes();

    const after = await timestamps(fileId);
    expect(after.accessed_at.getTime()).toBeGreaterThan(before.accessed_at.getTime());
  });
});

describe('sorting', () => {
  it('accepts accessedAt as a sort field', async () => {
    const { client: c } = await signUpAndLogin();
    await upload(c, { name: 'a.txt' });
    await upload(c, { name: 'b.txt' });

    const res = await c.get('/api/files').query({ sortBy: 'accessedAt', order: 'DESC' });

    expect(res.status).toBe(200);
    expect(res.body.every(item => item.accessedAt != null)).toBe(true);
  });
});
