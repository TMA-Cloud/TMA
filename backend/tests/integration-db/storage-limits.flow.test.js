/**
 * Storage quota enforcement end to end.
 *
 * The quota belongs to the account, not the login, so the interesting cases are
 * the ones that only a real database can settle: usage summed across an owner
 * and its sub-users, and a limit that must be rejected because it sits below
 * what is already stored.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { PERMISSIONS } from '../../utils/permissions.js';
import { ensureOwner, loginAs } from './helpers/app.js';
import { countRows } from './helpers/factories.js';

const KB = 1024;

/** Set a quota directly, bypassing the admin endpoint's first-user check. */
async function setLimit(userId, bytes) {
  await pool.query('UPDATE users SET storage_limit = $1 WHERE id = $2', [bytes, userId]);
}

function upload(c, { name = 'file.txt', bytes = 100 } = {}) {
  return c
    .post('/api/files/upload')
    .attach('file', Buffer.alloc(bytes, 0x41), { filename: name, contentType: 'text/plain' });
}

describe('quota enforcement on upload', () => {
  it('allows an upload that fits', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 10 * KB);

    expect((await upload(c, { bytes: 1 * KB })).status).toBeLessThan(400);
    expect(await countRows('files')).toBe(1);
  });

  it('rejects an upload that would exceed the quota, with 413', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 2 * KB);

    const res = await upload(c, { bytes: 8 * KB });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('STORAGE_LIMIT_EXCEEDED');
  });

  it('writes nothing when the upload is refused', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 2 * KB);

    await upload(c, { bytes: 8 * KB });

    expect(await countRows('files')).toBe(0);
  });

  it('explains the quota in the message', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 2 * KB);

    const res = await upload(c, { bytes: 8 * KB });

    expect(res.body.message).toMatch(/Storage limit exceeded/);
    expect(res.body.message).toMatch(/available/);
  });

  it('blocks the next upload once the quota is consumed', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 5 * KB);

    expect((await upload(c, { name: 'a.txt', bytes: 4 * KB })).status).toBeLessThan(400);
    expect((await upload(c, { name: 'b.txt', bytes: 4 * KB })).status).toBe(413);
  });

  it('allows uploads again after files are purged', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 5 * KB);
    await upload(c, { name: 'a.txt', bytes: 4 * KB });

    const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file'");
    await c.post('/api/files/delete').send({ ids: [rows[0].id] });
    await c.post('/api/files/trash/delete').send({ ids: [rows[0].id] });

    expect((await upload(c, { name: 'b.txt', bytes: 4 * KB })).status).toBeLessThan(400);
  });

  it('imposes no ceiling when the account has no limit', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, null);

    expect((await upload(c, { bytes: 64 * KB })).status).toBeLessThan(400);
  });

  it('answers the pre-upload check consistently with the real upload', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 2 * KB);

    const check = await c.post('/api/files/upload/check').send({ fileSize: 8 * KB });
    const real = await upload(c, { bytes: 8 * KB });

    expect(check.status).toBe(real.status);
  });
});

describe('the quota belongs to the account, not the login', () => {
  it("a sub-user upload is measured against the owner's quota", async () => {
    const owner = await ensureOwner();
    await setLimit(owner.user.id, 5 * KB);

    const email = `member-${Date.now().toString(36)}@example.com`;
    await owner.client
      .post('/api/user/sub-users')
      .send({ email, password: 'correct-horse', name: 'Member', permissions: [PERMISSIONS.UPLOAD] });
    const { client: sub } = await loginAs(email, 'correct-horse');

    expect((await upload(sub, { name: 'a.txt', bytes: 4 * KB })).status).toBeLessThan(400);
    expect((await upload(sub, { name: 'b.txt', bytes: 4 * KB })).status).toBe(413);
  });

  it("the owner's own uploads count against the same pool", async () => {
    const owner = await ensureOwner();
    await setLimit(owner.user.id, 5 * KB);

    const email = `member-${Date.now().toString(36)}@example.com`;
    await owner.client
      .post('/api/user/sub-users')
      .send({ email, password: 'correct-horse', name: 'Member', permissions: [PERMISSIONS.UPLOAD] });
    const { client: sub } = await loginAs(email, 'correct-horse');

    await upload(owner.client, { name: 'owner.txt', bytes: 4 * KB });

    expect((await upload(sub, { name: 'member.txt', bytes: 4 * KB })).status).toBe(413);
  });

  it('a sub-user has no quota of its own to raise', async () => {
    const owner = await ensureOwner();
    const email = `member-${Date.now().toString(36)}@example.com`;
    const created = await owner.client
      .post('/api/user/sub-users')
      .send({ email, password: 'correct-horse', name: 'Member', permissions: [] });

    const res = await owner.client
      .put('/api/user/storage-limit')
      .send({ targetUserId: created.body.subUser.id, storageLimit: 100 * KB });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('setting a limit through the admin endpoint', () => {
  it('the first account can set a limit on itself', async () => {
    const { client: c, user } = await ensureOwner();

    const res = await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: 64 * KB });

    expect(res.status).toBeLessThan(400);
    const { rows } = await pool.query('SELECT storage_limit FROM users WHERE id = $1', [user.id]);
    expect(Number(rows[0].storage_limit)).toBe(64 * KB);
  });

  it('refuses a limit below what the account already stores', async () => {
    const { client: c, user } = await ensureOwner();
    await upload(c, { bytes: 8 * KB });

    const res = await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: 1 * KB });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.message).toMatch(/already stores/i);
  });

  it('leaves the previous limit in place when the new one is rejected', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 64 * KB);
    await upload(c, { bytes: 8 * KB });

    await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: 1 * KB });

    const { rows } = await pool.query('SELECT storage_limit FROM users WHERE id = $1', [user.id]);
    expect(Number(rows[0].storage_limit)).toBe(64 * KB);
  });

  it('accepts a limit exactly equal to current usage', async () => {
    const { client: c, user } = await ensureOwner();
    await upload(c, { bytes: 4 * KB });

    const res = await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: 4 * KB });

    expect(res.status).toBeLessThan(400);
  });

  it('clears the limit when null is sent', async () => {
    const { client: c, user } = await ensureOwner();
    await setLimit(user.id, 4 * KB);

    const res = await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: null });

    expect(res.status).toBeLessThan(400);
    const { rows } = await pool.query('SELECT storage_limit FROM users WHERE id = $1', [user.id]);
    expect(rows[0].storage_limit).toBeNull();
  });

  it('rejects a zero or negative limit at the schema', async () => {
    const { client: c, user } = await ensureOwner();

    expect((await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: 0 })).status).toBe(422);
    expect((await c.put('/api/user/storage-limit').send({ targetUserId: user.id, storageLimit: -1 })).status).toBe(422);
  });
});
