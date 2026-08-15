/**
 * Client-supplied modification times, end to end against real rows.
 *
 * The claim under test is the two-clock split: `modified` describes the bytes
 * and so follows the uploader's file, while `created_at` describes the row and
 * so stays the server's own clock no matter what the client sends. Orphan
 * detection reads the second one, which is why a backdated upload must not be
 * able to drag it into the past.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { signUpAndLogin } from './helpers/app.js';

/** A time old enough that no test clock could produce it by accident. */
const OLD_MS = Date.UTC(2014, 2, 17, 8, 45, 0);

/**
 * Upload through the real multipart endpoint.
 * `lastModified` is left off entirely when null, mirroring a client that has
 * nothing to send.
 */
function upload(c, { name = 'notes.txt', content = 'hello world', lastModified = OLD_MS, parentId } = {}) {
  const req = c.post('/api/files/upload').attach('file', Buffer.from(content), {
    filename: name,
    contentType: 'text/plain',
  });
  if (parentId) req.field('parentId', parentId);
  if (lastModified !== null) req.field('lastModifiedTimes', String(lastModified));
  return req;
}

/** Bulk upload with per-file mtimes, index-aligned the way the browser sends them. */
function uploadBulk(c, files) {
  const req = c.post('/api/files/upload/bulk');
  for (const f of files) {
    req.attach('files', Buffer.from(f.content ?? 'x'), { filename: f.name, contentType: 'text/plain' });
  }
  for (const f of files) {
    req.field('relativePaths', f.relativePath ?? '');
    req.field('clientIds', f.clientId ?? f.name);
    req.field('lastModifiedTimes', f.lastModified == null ? '' : String(f.lastModified));
  }
  return req;
}

async function timestamps(id) {
  const { rows } = await pool.query('SELECT modified, created_at, accessed_at FROM files WHERE id = $1', [id]);
  return rows[0];
}

const isRecent = date => Math.abs(Date.now() - date.getTime()) < 60_000;

describe('single upload', () => {
  it("keeps the file's own modification time instead of the upload time", async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;

    const { modified } = await timestamps(id);
    expect(modified.getTime()).toBe(OLD_MS);
  });

  it('still stamps created_at with the server clock, which orphan detection depends on', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;

    const { created_at: createdAt } = await timestamps(id);
    expect(isRecent(createdAt)).toBe(true);
  });

  it('stamps accessed_at now, because writing an item counts as accessing it', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;

    const { accessed_at: accessedAt } = await timestamps(id);
    expect(isRecent(accessedAt)).toBe(true);
  });

  it('falls back to the upload time when the client sends nothing', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c, { lastModified: null })).body.id;

    const { modified } = await timestamps(id);
    expect(isRecent(modified)).toBe(true);
  });

  it('clamps a clock running fast rather than accepting a file from the future', async () => {
    const { client: c } = await signUpAndLogin();
    const ahead = Date.now() + 7 * 24 * 3600 * 1000;
    const id = (await upload(c, { lastModified: ahead })).body.id;

    const { modified } = await timestamps(id);
    expect(modified.getTime()).toBeLessThan(ahead);
    expect(isRecent(modified)).toBe(true);
  });

  it('ignores a pre-1980 time and uploads the file anyway', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await upload(c, { lastModified: 0 });

    expect(res.status).toBe(200);
    const { modified } = await timestamps(res.body.id);
    expect(isRecent(modified)).toBe(true);
  });

  it('does not fail the upload over an unparseable time', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await c
      .post('/api/files/upload')
      .attach('file', Buffer.from('hi'), { filename: 'a.txt', contentType: 'text/plain' })
      .field('lastModifiedTimes', 'yesterday-ish');

    expect(res.status).toBe(200);
    const { modified } = await timestamps(res.body.id);
    expect(isRecent(modified)).toBe(true);
  });
});

describe('bulk upload', () => {
  it('pairs each file with its own time', async () => {
    const { client: c } = await signUpAndLogin();
    const older = Date.UTC(2001, 0, 5);
    const res = await uploadBulk(c, [
      { name: 'a.txt', lastModified: OLD_MS },
      { name: 'b.txt', lastModified: older },
    ]);

    expect(res.status).toBe(200);
    const byName = new Map(res.body.files.map(f => [f.name, f.id]));
    expect((await timestamps(byName.get('a.txt'))).modified.getTime()).toBe(OLD_MS);
    expect((await timestamps(byName.get('b.txt'))).modified.getTime()).toBe(older);
  });

  it('keeps alignment when one file in the middle has no usable time', async () => {
    const { client: c } = await signUpAndLogin();
    const third = Date.UTC(1995, 6, 20);
    const res = await uploadBulk(c, [
      { name: 'a.txt', lastModified: OLD_MS },
      { name: 'b.txt', lastModified: null },
      { name: 'c.txt', lastModified: third },
    ]);

    expect(res.status).toBe(200);
    const byName = new Map(res.body.files.map(f => [f.name, f.id]));
    expect((await timestamps(byName.get('a.txt'))).modified.getTime()).toBe(OLD_MS);
    expect(isRecent((await timestamps(byName.get('b.txt'))).modified)).toBe(true);
    expect((await timestamps(byName.get('c.txt'))).modified.getTime()).toBe(third);
  });

  it('gives implicitly created folders the upload time, the way unzip does', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await uploadBulk(c, [{ name: 'a.txt', relativePath: 'Archive/a.txt', lastModified: OLD_MS }]);

    expect(res.status).toBe(200);
    const { rows } = await pool.query("SELECT modified FROM files WHERE name = 'Archive' AND type = 'folder'");
    expect(isRecent(rows[0].modified)).toBe(true);
  });
});

describe('replacing a file', () => {
  it("takes the replacing file's time, since the bytes are what changed", async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;
    const newer = Date.UTC(2020, 10, 2, 14, 0, 0);

    const res = await c
      .post(`/api/files/${id}/replace`)
      .attach('file', Buffer.from('updated contents'), { filename: 'notes.txt', contentType: 'text/plain' })
      .field('lastModifiedTimes', String(newer));

    expect(res.status).toBe(200);
    const { modified, accessed_at: accessedAt } = await timestamps(id);
    expect(modified.getTime()).toBe(newer);
    // The write is ours even though the mtime is not.
    expect(isRecent(accessedAt)).toBe(true);
  });

  it('falls back to now when the replacing client sends no time', async () => {
    const { client: c } = await signUpAndLogin();
    const id = (await upload(c)).body.id;

    const res = await c
      .post(`/api/files/${id}/replace`)
      .attach('file', Buffer.from('updated contents'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(200);
    expect(isRecent((await timestamps(id)).modified)).toBe(true);
  });
});
