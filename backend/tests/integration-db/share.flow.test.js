/**
 * Share links end to end, including anonymous access with no session at all.
 */

import { describe, expect, it } from 'vitest';
import request from 'supertest';

import pool from '../../config/db.js';
import { redisClient } from '../../config/redis.js';
import { cacheKeys } from '../../utils/cache.js';
import { createShareLink, cleanupExpiredShareLinks } from '../../models/share.model.js';
import { api, ensureOwner } from './helpers/app.js';
import { countRows, makeFolder } from './helpers/factories.js';

/** Collect a response body as a Buffer, for binary downloads. */
const asBuffer = req =>
  req.buffer().parse((res, cb) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });

/** Anonymous visitor: no cookies, no CSRF header. */
const visitor = () => request(api);

async function uploadFile(c, { name = 'shared.txt', content = 'public content' } = {}) {
  await c.post('/api/files/upload').attach('file', Buffer.from(content), { filename: name, contentType: 'text/plain' });
  const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file' AND name = $1", [name]);
  return rows[0].id;
}

/**
 * Force a link past its expiry.
 *
 * Production expiry happens by time passing, and the cache TTL is capped to the
 * link's remaining lifetime, so no cached entry can outlive it. Backdating the
 * row alone would leave a warmed entry behind, so drop it too.
 */
async function expireShare(token) {
  await pool.query("UPDATE share_links SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [token]);
  await redisClient.del(cacheKeys.shareByToken(token));
}

/** Share a file and return its public token. */
async function share(c, fileId, expiry) {
  const res = await c.post('/api/files/share').send({ ids: [fileId], shared: true, ...(expiry ? { expiry } : {}) });
  expect(res.status).toBeLessThan(400);

  const link = res.body.links?.[fileId] ?? Object.values(res.body.links || {})[0];
  expect(typeof link).toBe('string');
  return link.split('/s/')[1];
}

describe('creating a share link', () => {
  it('records a share link row', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    await share(c, fileId);

    expect(await countRows('share_links')).toBe(1);
  });

  it('marks the file as shared', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    await share(c, fileId);

    const { rows } = await pool.query('SELECT shared FROM files WHERE id = $1', [fileId]);
    expect(rows[0].shared).toBe(true);
  });

  it('returns a link on the configured origin', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    const res = await c.post('/api/files/share').send({ ids: [fileId], shared: true });
    const link = Object.values(res.body.links)[0];

    expect(link).toMatch(/\/s\/[A-Za-z0-9]{16}$/);
  });

  it('issues a token with enough entropy to resist guessing', async () => {
    const { client: c } = await ensureOwner();
    const token = await share(c, await uploadFile(c));

    expect(token).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('reuses the existing link when the same file is shared twice', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    const first = await share(c, fileId);
    const second = await share(c, fileId);

    expect(second).toBe(first);
    expect(await countRows('share_links')).toBe(1);
  });

  it('gives different files different tokens', async () => {
    const { client: c } = await ensureOwner();
    const a = await share(c, await uploadFile(c, { name: 'a.txt' }));
    const b = await share(c, await uploadFile(c, { name: 'b.txt' }));

    expect(a).not.toBe(b);
  });

  it('lists the link back to the owner', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);
    const token = await share(c, fileId);

    const res = await c.post('/api/files/share/links').send({ ids: [fileId] });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(token);
  });
});

describe('anonymous access', () => {
  it('serves the file to a visitor with no session', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c, { content: 'public content' });
    const token = await share(c, fileId);

    const res = await asBuffer(visitor().get(`/s/${token}`));

    expect(res.status).toBe(200);
    expect(res.body.toString('utf8')).toBe('public content');
  });

  it('decrypts correctly for the anonymous path too', async () => {
    const { client: c } = await ensureOwner();
    const binary = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 7) % 256));
    await c
      .post('/api/files/upload')
      .attach('file', binary, { filename: 'blob.bin', contentType: 'application/octet-stream' });
    const { rows } = await pool.query("SELECT id FROM files WHERE name = 'blob.bin'");
    const token = await share(c, rows[0].id);

    const res = await asBuffer(visitor().get(`/s/${token}`));

    expect(Buffer.compare(res.body, binary)).toBe(0);
  });

  it('needs no CSRF header, since it is a plain GET', async () => {
    const { client: c } = await ensureOwner();
    const token = await share(c, await uploadFile(c));

    expect((await visitor().get(`/s/${token}`)).status).toBe(200);
  });

  it('shows a not-found page for an unknown token', async () => {
    const res = await visitor().get('/s/AAAAAAAAAAAAAAAA');

    expect(res.status).toBe(404);
    expect(res.text).toContain('Link not found');
  });

  it('rejects a malformed token before hitting the database', async () => {
    expect((await visitor().get('/s/short')).status).toBeGreaterThanOrEqual(400);
  });

  it("does not leak the owner's other files", async () => {
    const { client: c } = await ensureOwner();
    const sharedId = await uploadFile(c, { name: 'shared.txt', content: 'public' });
    await uploadFile(c, { name: 'private.txt', content: 'SECRET-NOT-SHARED' });
    const token = await share(c, sharedId);

    const res = await asBuffer(visitor().get(`/s/${token}`));

    expect(res.body.toString('utf8')).not.toContain('SECRET-NOT-SHARED');
  });
});

describe('expiry', () => {
  it('stores an expiry date for the default window', async () => {
    const { client: c } = await ensureOwner();
    await share(c, await uploadFile(c));

    const { rows } = await pool.query('SELECT expires_at FROM share_links');
    expect(rows[0].expires_at).not.toBeNull();
  });

  it('honours an explicit never-expires choice', async () => {
    const { client: c } = await ensureOwner();
    await share(c, await uploadFile(c), 'never');

    const { rows } = await pool.query('SELECT expires_at FROM share_links');
    expect(rows[0].expires_at).toBeNull();
  });

  it('refuses an expired link', async () => {
    const { client: c } = await ensureOwner();
    const token = await share(c, await uploadFile(c));

    await expireShare(token);

    const res = await visitor().get(`/s/${token}`);

    expect(res.status).toBe(410);
    expect(res.text).toContain('Link expired');
  });

  it('rejects an unsupported expiry value', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    const res = await c.post('/api/files/share').send({ ids: [fileId], shared: true, expiry: 'forever-and-ever' });

    expect(res.status).toBe(422);
  });
});

describe('revoking', () => {
  it('unsharing stops anonymous access', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);
    const token = await share(c, fileId);
    expect((await visitor().get(`/s/${token}`)).status).toBe(200);

    const res = await c.post('/api/files/share').send({ ids: [fileId], shared: false });
    expect(res.status).toBeLessThan(400);

    expect((await visitor().get(`/s/${token}`)).status).toBe(404);
  });

  it('clears the shared flag on the file', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);
    await share(c, fileId);

    await c.post('/api/files/share').send({ ids: [fileId], shared: false });

    const { rows } = await pool.query('SELECT shared FROM files WHERE id = $1', [fileId]);
    expect(rows[0].shared).toBe(false);
  });

  it('a purged file is no longer reachable through its old link', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);
    const token = await share(c, fileId);

    await c.post('/api/files/delete').send({ ids: [fileId] });
    await c.post('/api/files/trash/delete').send({ ids: [fileId] });

    expect((await visitor().get(`/s/${token}`)).status).toBe(404);
  });
});

describe('shared folders', () => {
  it('renders a listing page rather than a download', async () => {
    const { client: c } = await ensureOwner();
    const folder = await c.post('/api/files/folder').send({ name: 'Public Folder' });
    const folderId = folder.body.folder?.id || folder.body.id;
    await c
      .post('/api/files/upload')
      .field('parentId', folderId)
      .attach('file', Buffer.from('inside'), { filename: 'inside.txt', contentType: 'text/plain' });

    const token = await share(c, folderId);
    const res = await visitor().get(`/s/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('Public Folder');
    expect(res.text).toContain('inside.txt');
  });

  it('refuses to create a folder whose name contains markup', async () => {
    const { client: c } = await ensureOwner();
    const res = await c.post('/api/files/folder').send({ name: '<script>alert(1)</script>' });

    expect(res.status).toBe(422);
    expect(await countRows('files')).toBe(0);
  });

  it('escapes a name containing markup on the share page, in case a row was written another way', async () => {
    // The API blocks these names, so this row is seeded directly — the point is
    // that the public page escapes whatever it finds rather than trusting that
    // the input layer caught it.
    const { client: c, user } = await ensureOwner();
    const folder = await makeFolder(user.id, { name: '<script>alert(1)</script>' });

    const token = await share(c, folder.id);
    const res = await visitor().get(`/s/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
  });
});

describe('expiry on re-share', () => {
  it('updates the expiry of an existing link to the newly chosen value', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    await share(c, fileId, '7d');
    const first = (await pool.query('SELECT expires_at FROM share_links')).rows[0].expires_at;

    await share(c, fileId, '30d');
    const second = (await pool.query('SELECT expires_at FROM share_links')).rows[0].expires_at;

    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('can move a dated link to never-expires', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    await share(c, fileId, '7d');
    await share(c, fileId, 'never');

    expect((await pool.query('SELECT expires_at FROM share_links')).rows[0].expires_at).toBeNull();
  });

  it('can put an expiry back on a never-expires link', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);

    await share(c, fileId, 'never');
    await share(c, fileId, '7d');

    expect((await pool.query('SELECT expires_at FROM share_links')).rows[0].expires_at).not.toBeNull();
  });

  it('re-sharing an expired link brings it back to life', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);
    const token = await share(c, fileId);
    await expireShare(token);
    expect((await visitor().get(`/s/${token}`)).status).toBe(410);

    await share(c, fileId, '30d');

    expect((await visitor().get(`/s/${token}`)).status).toBe(200);
  });
});

describe('expired links are refused on every route', () => {
  /** A shared folder holding one file, plus its token. */
  async function sharedFolder(c) {
    const folder = await c.post('/api/files/folder').send({ name: 'Public' });
    const folderId = folder.body.folder?.id || folder.body.id;
    await c
      .post('/api/files/upload')
      .field('parentId', folderId)
      .attach('file', Buffer.from('inside'), { filename: 'inside.txt', contentType: 'text/plain' });
    const { rows } = await pool.query("SELECT id FROM files WHERE name = 'inside.txt'");
    return { token: await share(c, folderId), innerId: rows[0].id };
  }

  it('refuses the single-item download with 410', async () => {
    const { client: c } = await ensureOwner();
    const { token, innerId } = await sharedFolder(c);
    expect((await visitor().get(`/s/${token}/file/${innerId}`)).status).toBe(200);

    await expireShare(token);

    expect((await visitor().get(`/s/${token}/file/${innerId}`)).status).toBe(410);
  });

  it('refuses the ZIP export with 410', async () => {
    const { client: c } = await ensureOwner();
    const { token } = await sharedFolder(c);

    await expireShare(token);

    expect((await visitor().get(`/s/${token}/zip`)).status).toBe(410);
  });

  it('serves the ZIP while the link is live', async () => {
    const { client: c } = await ensureOwner();
    const { token } = await sharedFolder(c);

    const res = await visitor().get(`/s/${token}/zip`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('zip');
  });

  it('will not serve a file that is not part of the share', async () => {
    const { client: c } = await ensureOwner();
    const { token } = await sharedFolder(c);
    const outsiderId = await uploadFile(c, { name: 'outside.txt', content: 'NOT-IN-THE-SHARE' });

    const res = await visitor().get(`/s/${token}/file/${outsiderId}`);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the expired-link cleanup job', () => {
  it('removes an expired link and its file rows', async () => {
    const { client: c } = await ensureOwner();
    const token = await share(c, await uploadFile(c));
    await expireShare(token);

    await cleanupExpiredShareLinks();

    expect(await countRows('share_links')).toBe(0);
    expect(await countRows('share_link_files')).toBe(0);
  });

  it('clears the shared flag on files that no longer have a link', async () => {
    const { client: c } = await ensureOwner();
    const fileId = await uploadFile(c);
    const token = await share(c, fileId);
    await expireShare(token);

    await cleanupExpiredShareLinks();

    const { rows } = await pool.query('SELECT shared FROM files WHERE id = $1', [fileId]);
    expect(rows[0].shared).toBe(false);
  });

  it('leaves a live link alone', async () => {
    const { client: c } = await ensureOwner();
    const token = await share(c, await uploadFile(c));

    await cleanupExpiredShareLinks();

    expect(await countRows('share_links')).toBe(1);
    expect((await visitor().get(`/s/${token}`)).status).toBe(200);
  });

  it('leaves a never-expires link alone', async () => {
    const { client: c } = await ensureOwner();
    await share(c, await uploadFile(c), 'never');

    await cleanupExpiredShareLinks();

    expect(await countRows('share_links')).toBe(1);
  });

  it('is safe to run when there is nothing to clean', async () => {
    await ensureOwner();
    await expect(cleanupExpiredShareLinks()).resolves.not.toThrow();
  });
});

describe('the cache can never outlive the link', () => {
  it("caps the cache TTL at the link's remaining lifetime", async () => {
    // Documented in Concepts → Sharing Model: "Redis cache TTL is capped at the
    // link's remaining lifetime to prevent stale access."
    const { client: c, user } = await ensureOwner();
    const fileId = await uploadFile(c);
    const token = await createShareLink(fileId, user.id, [fileId], new Date(Date.now() + 30_000));

    await visitor().get(`/s/${token}`);

    const ttl = await redisClient.ttl(cacheKeys.shareByToken(token));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
  });

  it('uses the default TTL when the link never expires', async () => {
    const { client: c } = await ensureOwner();
    const token = await share(c, await uploadFile(c), 'never');

    await visitor().get(`/s/${token}`);

    expect(await redisClient.ttl(cacheKeys.shareByToken(token))).toBeGreaterThan(30);
  });

  it('discards a cached entry whose expiry has since passed', async () => {
    const { client: c, user } = await ensureOwner();
    const fileId = await uploadFile(c);
    // Warm the cache with an entry that expires almost immediately.
    const token = await createShareLink(fileId, user.id, [fileId], new Date(Date.now() + 1000));
    await visitor().get(`/s/${token}`);

    await new Promise(resolve => {
      setTimeout(resolve, 1200);
    });

    expect((await visitor().get(`/s/${token}`)).status).toBe(410);
  });
});
