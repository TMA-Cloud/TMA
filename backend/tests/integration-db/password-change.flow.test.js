/**
 * Password change end to end.
 *
 * The wiki makes four promises here (Concepts → Authentication, Admin → Signup
 * Control): the feature can be switched off instance-wide, a change requires
 * *recent* authentication, it invalidates every session, and — because each
 * login on an account is independent — changing one does not disturb the
 * others.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { PERMISSIONS } from '../../utils/permissions.js';
import { ensureOwner, loginAs } from './helpers/app.js';
import { countRows } from './helpers/factories.js';

/** The feature ships disabled; the admin toggle turns it on. */
async function allowPasswordChange(adminClient, enabled = true) {
  const res = await adminClient.put('/api/user/password-change-config').send({ enabled });
  expect(res.status).toBeLessThan(400);
}

/** Age a session past the 10-minute recent-auth window. */
async function agePastRecentWindow(userId) {
  await pool.query(`UPDATE sessions SET created_at = NOW() - INTERVAL '20 minutes' WHERE user_id = $1`, [userId]);
}

describe('the instance-wide toggle', () => {
  it('refuses a password change while the feature is off', async () => {
    const { client: c } = await ensureOwner();

    const res = await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/disabled by the administrator/i);
  });

  it('allows it once the admin turns it on', async () => {
    const { client: c } = await ensureOwner();
    await allowPasswordChange(c);

    const res = await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect(res.status).toBeLessThan(400);
  });

  it('checks the toggle before the current password, so it cannot be probed while off', async () => {
    const { client: c } = await ensureOwner();

    const res = await c.post('/api/change-password').send({ oldPassword: 'wrong-entirely', newPassword: 'new-secret' });

    expect(res.status).toBe(403);
    expect(res.body.message).not.toMatch(/current password/i);
  });
});

describe('changing the password', () => {
  it('rejects an incorrect current password', async () => {
    const { client: c } = await ensureOwner();
    await allowPasswordChange(c);

    const res = await c
      .post('/api/change-password')
      .send({ oldPassword: 'not-my-password', newPassword: 'new-secret' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Current password is incorrect/i);
  });

  it('rejects reusing the same password', async () => {
    const { client: c } = await ensureOwner();
    await allowPasswordChange(c);

    const res = await c
      .post('/api/change-password')
      .send({ oldPassword: 'correct-horse', newPassword: 'correct-horse' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/must be different/i);
  });

  it('rejects a new password under six characters at the schema', async () => {
    const { client: c } = await ensureOwner();
    await allowPasswordChange(c);

    const res = await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: '12345' });

    expect(res.status).toBe(422);
  });

  it('stores a new hash, never the plaintext', async () => {
    const { client: c, user } = await ensureOwner();
    await allowPasswordChange(c);
    const before = (await pool.query('SELECT password FROM users WHERE id = $1', [user.id])).rows[0].password;

    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    const after = (await pool.query('SELECT password FROM users WHERE id = $1', [user.id])).rows[0].password;
    expect(after).not.toBe(before);
    expect(after).not.toBe('new-secret');
    expect(after).toMatch(/^\$2[aby]\$/);
  });

  it('lets the user log in with the new password afterwards', async () => {
    const { client: c, email } = await ensureOwner();
    await allowPasswordChange(c);
    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    const { response } = await loginAs(email, 'new-secret');

    expect(response.status).toBe(200);
  });

  it('stops the old password working', async () => {
    const { client: c, email } = await ensureOwner();
    await allowPasswordChange(c);
    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    const { response } = await loginAs(email, 'correct-horse');

    expect(response.status).toBe(401);
  });
});

describe('recent-authentication gate', () => {
  it('refuses a change from a session older than the ten-minute window', async () => {
    const { client: c, user } = await ensureOwner();
    await allowPasswordChange(c);
    await agePastRecentWindow(user.id);

    const res = await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/log in again/i);
  });

  it('leaves the password untouched when the gate refuses', async () => {
    const { client: c, user, email } = await ensureOwner();
    await allowPasswordChange(c);
    await agePastRecentWindow(user.id);

    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect((await loginAs(email, 'correct-horse')).response.status).toBe(200);
  });

  it('accepts the change again after a fresh login', async () => {
    const { client: c, user, email } = await ensureOwner();
    await allowPasswordChange(c);
    await agePastRecentWindow(user.id);

    const { client: fresh } = await loginAs(email, 'correct-horse');
    const res = await fresh
      .post('/api/change-password')
      .send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect(res.status).toBeLessThan(400);
  });
});

describe('session invalidation', () => {
  it('logs every device out, including the one that made the change', async () => {
    const { client: c, email } = await ensureOwner();
    await allowPasswordChange(c);
    await loginAs(email, 'correct-horse');
    expect(await countRows('sessions')).toBeGreaterThan(1);

    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect(await countRows('sessions')).toBe(0);
    expect((await c.get('/api/profile')).status).toBe(401);
  });

  it('bumps the token version, so an outstanding token cannot be replayed', async () => {
    const { client: c, user } = await ensureOwner();
    await allowPasswordChange(c);
    const before = (await pool.query('SELECT token_version FROM users WHERE id = $1', [user.id])).rows[0].token_version;

    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    const after = (await pool.query('SELECT token_version FROM users WHERE id = $1', [user.id])).rows[0].token_version;
    expect(after).toBeGreaterThan(before);
  });

  it('invalidates a session held by a different device', async () => {
    const { client: c, email } = await ensureOwner();
    await allowPasswordChange(c);
    const other = await loginAs(email, 'correct-horse');
    expect((await other.client.get('/api/profile')).status).toBe(200);

    await c.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect((await other.client.get('/api/profile')).status).toBe(401);
  });
});

describe('logins on one account are independent', () => {
  /** Owner plus a freshly logged-in sub-user. */
  async function accountWithMember() {
    const owner = await ensureOwner();
    await allowPasswordChange(owner.client);

    const email = `member-${Date.now().toString(36)}@example.com`;
    await owner.client
      .post('/api/user/sub-users')
      .send({ email, password: 'correct-horse', name: 'Member', permissions: [PERMISSIONS.DOWNLOAD] });
    const { client: sub } = await loginAs(email, 'correct-horse');

    return { owner, sub, subEmail: email };
  }

  it('a sub-user changing its password does not log the owner out', async () => {
    const { owner, sub } = await accountWithMember();

    const res = await sub
      .post('/api/change-password')
      .send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });
    expect(res.status).toBeLessThan(400);

    expect((await owner.client.get('/api/profile')).status).toBe(200);
  });

  it('the owner changing its password does not log the sub-user out', async () => {
    const { owner, sub } = await accountWithMember();

    await owner.client.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect((await sub.get('/api/files')).status).toBe(200);
  });

  it("only the changing login's sessions are dropped", async () => {
    const { owner, sub } = await accountWithMember();

    await sub.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    // The owner still holds its own sessions; only the member's were cleared.
    expect(await countRows('sessions')).toBeGreaterThan(0);
    expect((await sub.get('/api/files')).status).toBe(401);
    expect((await owner.client.get('/api/profile')).status).toBe(200);
  });

  it("the sub-user's new password works and the owner's is unchanged", async () => {
    const { owner, subEmail } = await accountWithMember();
    const { client: sub } = await loginAs(subEmail, 'correct-horse');
    await sub.post('/api/change-password').send({ oldPassword: 'correct-horse', newPassword: 'new-secret' });

    expect((await loginAs(subEmail, 'new-secret')).response.status).toBe(200);
    expect((await loginAs(owner.email, 'correct-horse')).response.status).toBe(200);
  });
});
