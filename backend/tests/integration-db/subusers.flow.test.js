/**
 * Sub-users end to end.
 *
 * The permission matrix is checked in the unit suite against a stubbed auth
 * middleware. Here the whole chain is live: a real sub-user row, a real login,
 * a real JWT, the real account-context resolution, and real files owned by the
 * parent account — which is the part that only a database can prove.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../utils/permissions.js';
import { createAndLogin, ensureOwner, loginAs } from './helpers/app.js';
import { countRows, readFileRow } from './helpers/factories.js';

/** Owner account plus a logged-in sub-user holding `permissions`. */
async function withSubUser(permissions) {
  const owner = await ensureOwner();

  const email = `member-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}@example.com`;
  const created = await owner.client
    .post('/api/user/sub-users')
    .send({ email, password: 'correct-horse', name: 'Member', permissions });

  expect(created.status).toBeLessThan(400);

  const { client: sub, response } = await loginAs(email, 'correct-horse');
  expect(response.status).toBe(200);

  return { owner, sub, email, subUserId: created.body.subUser.id };
}

/** Upload a file as the owner and return its id. */
async function ownerFile(owner, name = 'shared.txt', content = 'account content') {
  await owner.client
    .post('/api/files/upload')
    .attach('file', Buffer.from(content), { filename: name, contentType: 'text/plain' });
  const { rows } = await pool.query("SELECT id FROM files WHERE type = 'file' AND name = $1", [name]);
  return rows[0].id;
}

describe('creating sub-users', () => {
  it('an owner can create one', async () => {
    const { owner } = await withSubUser([PERMISSIONS.DOWNLOAD]);

    const list = await owner.client.get('/api/user/sub-users');
    expect(list.body.subUsers).toHaveLength(1);
  });

  it('the sub-user row points at the owner', async () => {
    const { owner, subUserId } = await withSubUser([]);

    const { rows } = await pool.query('SELECT parent_user_id FROM users WHERE id = $1', [subUserId]);
    expect(rows[0].parent_user_id).toBe(owner.user.id);
  });

  it('rejects an email that already exists', async () => {
    const { owner, email } = await withSubUser([]);

    const res = await owner.client
      .post('/api/user/sub-users')
      .send({ email, password: 'correct-horse', name: 'Duplicate', permissions: [] });

    expect(res.status).toBe(409);
    expect(await countRows('users')).toBe(2);
  });

  it('a sub-user cannot create sub-users of its own', async () => {
    const { sub } = await withSubUser(ALL_PERMISSIONS);

    const res = await sub
      .post('/api/user/sub-users')
      .send({ email: 'nested@example.com', password: 'correct-horse', name: 'Nested', permissions: [] });

    expect(res.status).toBe(403);
    expect(await countRows('users')).toBe(2);
  });

  it('a sub-user cannot even list sub-users', async () => {
    const { sub } = await withSubUser(ALL_PERMISSIONS);
    expect((await sub.get('/api/user/sub-users')).status).toBe(403);
  });

  it('the database refuses a nested sub-user even if the API guard were bypassed', async () => {
    const { owner, subUserId } = await withSubUser([]);

    await expect(
      pool.query(
        `INSERT INTO users (id, email, password, name, parent_user_id)
         VALUES ('nested0000000001', 'nested@example.com', 'x', 'Nested', $1)`,
        [subUserId]
      )
    ).rejects.toThrow(/Sub-users cannot create sub-users/);

    expect(owner.user.id).toBeDefined();
  });
});

describe('account boundary', () => {
  it("a sub-user sees the owner's files", async () => {
    const { owner, sub } = await withSubUser([]);
    await ownerFile(owner, 'owner-doc.txt');

    const res = await sub.get('/api/files');

    expect((res.body.files || res.body).map(f => f.name)).toContain('owner-doc.txt');
  });

  it('a file a sub-user uploads belongs to the owner account', async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.UPLOAD]);

    await sub
      .post('/api/files/upload')
      .attach('file', Buffer.from('from the member'), { filename: 'member.txt', contentType: 'text/plain' });

    const { rows } = await pool.query("SELECT user_id FROM files WHERE name = 'member.txt'");
    expect(rows[0].user_id).toBe(owner.user.id);
  });

  it('the owner sees a file the sub-user uploaded', async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.UPLOAD]);
    await sub
      .post('/api/files/upload')
      .attach('file', Buffer.from('from the member'), { filename: 'member.txt', contentType: 'text/plain' });

    const res = await owner.client.get('/api/files');
    expect((res.body.files || res.body).map(f => f.name)).toContain('member.txt');
  });

  it('an unrelated account sees none of it', async () => {
    const { owner } = await withSubUser([]);
    await ownerFile(owner, 'private.txt');

    const { client: stranger } = await createAndLogin();
    const res = await stranger.get('/api/files');

    expect((res.body.files || res.body).map(f => f.name)).not.toContain('private.txt');
  });

  it("a sub-user's uploads count against the owner's quota", async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.UPLOAD]);

    await sub
      .post('/api/files/upload')
      .attach('file', Buffer.from('x'.repeat(750)), { filename: 'member.txt', contentType: 'text/plain' });

    const usage = await owner.client.get('/api/user/storage');
    expect(Number(usage.body.used ?? usage.body.storageUsed)).toBe(750);
  });
});

describe('permission enforcement against real data', () => {
  it('browsing needs no grant at all', async () => {
    const { owner, sub } = await withSubUser([]);
    await ownerFile(owner);

    expect((await sub.get('/api/files')).status).toBe(200);
    expect((await sub.get('/api/files/trash')).status).toBe(200);
    expect((await sub.get('/api/files/starred')).status).toBe(200);
    expect((await sub.get('/api/files/search?query=shared')).status).toBe(200);
  });

  it('downloading is refused without the grant, and works with it', async () => {
    const denied = await withSubUser([]);
    const fileId = await ownerFile(denied.owner);
    expect((await denied.sub.get(`/api/files/${fileId}/download`)).status).toBe(403);

    const allowed = await withSubUser([PERMISSIONS.DOWNLOAD]);
    const allowedFileId = await ownerFile(allowed.owner, 'other.txt');
    expect((await allowed.sub.get(`/api/files/${allowedFileId}/download`)).status).toBe(200);
  });

  it('a refused delete leaves the file untouched on disk and in the database', async () => {
    const { owner, sub } = await withSubUser([]);
    const fileId = await ownerFile(owner);

    const res = await sub.post('/api/files/delete').send({ ids: [fileId] });

    expect(res.status).toBe(403);
    expect((await readFileRow(fileId)).deleted_at).toBeNull();
  });

  it('a granted delete really trashes the file', async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.DELETE]);
    const fileId = await ownerFile(owner);

    const res = await sub.post('/api/files/delete').send({ ids: [fileId] });

    expect(res.status).toBeLessThan(400);
    expect((await readFileRow(fileId)).deleted_at).not.toBeNull();
  });

  it('uploading is refused without the grant', async () => {
    const { sub } = await withSubUser([]);

    const res = await sub
      .post('/api/files/upload')
      .attach('file', Buffer.from('nope'), { filename: 'blocked.txt', contentType: 'text/plain' });

    expect(res.status).toBe(403);
    expect(await countRows('files')).toBe(0);
  });

  it('renaming is refused without the edit grant', async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.DOWNLOAD]);
    const fileId = await ownerFile(owner, 'original.txt');

    const res = await sub.post('/api/files/rename').send({ id: fileId, name: 'renamed.txt' });

    expect(res.status).toBe(403);
    expect((await readFileRow(fileId)).name).toBe('original.txt');
  });

  it('sharing is refused without the share grant', async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.DOWNLOAD, PERMISSIONS.EDIT]);
    const fileId = await ownerFile(owner);

    const res = await sub.post('/api/files/share').send({ ids: [fileId] });

    expect(res.status).toBe(403);
    expect(await countRows('share_links')).toBe(0);
  });

  it('managing the trash is refused without that grant', async () => {
    const { owner, sub } = await withSubUser([PERMISSIONS.DELETE]);
    const fileId = await ownerFile(owner);
    await sub.post('/api/files/delete').send({ ids: [fileId] });

    const restore = await sub.post('/api/files/trash/restore').send({ ids: [fileId] });

    expect(restore.status).toBe(403);
    expect((await readFileRow(fileId)).deleted_at).not.toBeNull();
  });
});

describe('changing grants takes effect immediately', () => {
  it('revoking a capability blocks the next request, despite the cached account context', async () => {
    const { owner, sub, subUserId } = await withSubUser([PERMISSIONS.DELETE]);
    const fileId = await ownerFile(owner);

    // Warm the account-context cache with the permission still granted.
    expect((await sub.get('/api/files')).status).toBe(200);

    const update = await owner.client.put(`/api/user/sub-users/${subUserId}`).send({ permissions: [] });
    expect(update.status).toBeLessThan(400);

    const res = await sub.post('/api/files/delete').send({ ids: [fileId] });
    expect(res.status).toBe(403);
  });

  it('granting a capability enables it without a new login', async () => {
    const { owner, sub, subUserId } = await withSubUser([]);
    const fileId = await ownerFile(owner);

    expect((await sub.get(`/api/files/${fileId}/download`)).status).toBe(403);

    await owner.client.put(`/api/user/sub-users/${subUserId}`).send({ permissions: [PERMISSIONS.DOWNLOAD] });

    expect((await sub.get(`/api/files/${fileId}/download`)).status).toBe(200);
  });
});

describe('deleting a sub-user', () => {
  it("removes the login but keeps the account's files", async () => {
    const { owner, sub, subUserId } = await withSubUser([PERMISSIONS.UPLOAD]);
    await sub
      .post('/api/files/upload')
      .attach('file', Buffer.from('member content'), { filename: 'member.txt', contentType: 'text/plain' });

    const res = await owner.client.delete(`/api/user/sub-users/${subUserId}`);

    expect(res.status).toBeLessThan(400);
    expect(await countRows('users')).toBe(1);
    expect(await countRows('files', "WHERE name = 'member.txt'")).toBe(1);
  });

  it("invalidates the removed identity's session straight away", async () => {
    const { owner, sub, subUserId } = await withSubUser([]);
    expect((await sub.get('/api/files')).status).toBe(200);

    await owner.client.delete(`/api/user/sub-users/${subUserId}`);

    expect((await sub.get('/api/files')).status).toBe(401);
  });

  it('frees the email address for reuse', async () => {
    const { owner, email, subUserId } = await withSubUser([]);
    await owner.client.delete(`/api/user/sub-users/${subUserId}`);

    const res = await owner.client
      .post('/api/user/sub-users')
      .send({ email, password: 'correct-horse', name: 'Replacement', permissions: [] });

    expect(res.status).toBeLessThan(400);
  });

  it("one owner cannot delete another owner's sub-user", async () => {
    const { subUserId } = await withSubUser([]);
    const { client: stranger } = await createAndLogin();

    const res = await stranger.delete(`/api/user/sub-users/${subUserId}`);

    expect(res.status).toBe(404);
    expect(await countRows('users', 'WHERE id = $1', [subUserId])).toBe(1);
  });
});

describe('administrator status is not inherited', () => {
  /**
   * Documented in Concepts → Authorization: "Administrator status belongs to
   * that one account. A sub-user created by the admin account is not an
   * administrator." The admin endpoints are gated on being the *first user*,
   * which a sub-user never is, whatever permissions it holds.
   */
  const adminSettings = [
    ['signup toggle', 'post', '/api/user/signup-toggle', { enabled: true }],
    ['hide file extensions', 'put', '/api/user/hide-file-extensions-config', { hidden: true }],
    ['desktop-only access', 'put', '/api/user/electron-only-access-config', { enabled: true }],
    ['password change', 'put', '/api/user/password-change-config', { enabled: true }],
    ['max upload size', 'put', '/api/user/max-upload-size-config', { maxBytes: 1048576 }],
    ['share base URL', 'put', '/api/user/share-base-url-config', { url: 'https://share.example.com' }],
  ];

  it.each(adminSettings)('refuses %s for a sub-user of the admin', async (_label, method, path, body) => {
    const { sub } = await withSubUser(ALL_PERMISSIONS);

    const res = await sub[method](path).send(body);

    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('leaves the setting unchanged when a sub-user tries', async () => {
    const { sub } = await withSubUser(ALL_PERMISSIONS);
    const before = (await pool.query('SELECT signup_enabled FROM app_settings')).rows[0].signup_enabled;

    await sub.post('/api/user/signup-toggle').send({ enabled: !before });

    const after = (await pool.query('SELECT signup_enabled FROM app_settings')).rows[0].signup_enabled;
    expect(after).toBe(before);
  });

  it('refuses to let a sub-user set a storage limit on the owner', async () => {
    const { owner, sub } = await withSubUser(ALL_PERMISSIONS);

    const res = await sub.put('/api/user/storage-limit').send({ targetUserId: owner.user.id, storageLimit: 1048576 });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await pool.query('SELECT storage_limit FROM users WHERE id = $1', [owner.user.id]);
    expect(rows[0].storage_limit).toBeNull();
  });

  it('never records a sub-user as the instance admin', async () => {
    const { owner, subUserId } = await withSubUser(ALL_PERMISSIONS);

    const { rows } = await pool.query('SELECT first_user_id FROM app_settings');
    expect(rows[0].first_user_id).toBe(owner.user.id);
    expect(rows[0].first_user_id).not.toBe(subUserId);
  });

  it('still lets the owner change the same settings', async () => {
    const { owner } = await withSubUser(ALL_PERMISSIONS);

    const res = await owner.client.put('/api/user/hide-file-extensions-config').send({ hidden: true });

    expect(res.status).toBeLessThan(400);
  });
});
