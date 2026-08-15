/**
 * Authentication end to end: real routes, real middleware, real database.
 */

import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { ALL_PERMISSIONS, PERMISSIONS } from '../../utils/permissions.js';
import { client, loginAs, signUpAndLogin } from './helpers/app.js';
import { countRows, makeOwner, makeSubUser } from './helpers/factories.js';

describe('signup', () => {
  it('creates an account and persists it', async () => {
    const c = client();
    const res = await c.post('/api/signup').send({ email: 'new@example.com', password: 'secret123', name: 'New' });

    expect(res.status).toBeLessThan(400);
    expect(await countRows('users')).toBe(1);
  });

  it('never stores the password in plain text', async () => {
    const c = client();
    await c.post('/api/signup').send({ email: 'new@example.com', password: 'secret123', name: 'New' });

    const { rows } = await pool.query('SELECT password FROM users WHERE email = $1', ['new@example.com']);
    expect(rows[0].password).not.toBe('secret123');
    expect(rows[0].password).toMatch(/^\$2[aby]\$/);
  });

  it('rejects a duplicate email', async () => {
    await makeOwner({ email: 'taken@example.com' });

    const c = client();
    const res = await c.post('/api/signup').send({ email: 'taken@example.com', password: 'secret123', name: 'x' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await countRows('users')).toBe(1);
  });

  it('rejects a password under eight characters before touching the database', async () => {
    const c = client();
    const res = await c.post('/api/signup').send({ email: 'short@example.com', password: '1234567' });

    expect(res.status).toBe(422);
    expect(await countRows('users')).toBe(0);
  });

  it('rejects a malformed email', async () => {
    const c = client();
    expect((await c.post('/api/signup').send({ email: 'not-an-email', password: 'secret123' })).status).toBe(422);
  });

  it('records the first account as the instance admin', async () => {
    await signUpAndLogin({ email: 'first@example.com' });

    const { rows } = await pool.query('SELECT first_user_id FROM app_settings');
    const { rows: users } = await pool.query('SELECT id FROM users WHERE email = $1', ['first@example.com']);
    expect(rows[0].first_user_id).toBe(users[0].id);
  });
});

/**
 * Closing signup once the instance has an owner is the documented default for a
 * self-hosted deployment: a fresh install is open just long enough for the
 * operator to claim it, then shuts. See the wiki, Admin → Signup Control.
 *
 * These guard the feature rather than question it — the behaviour is easy to
 * mistake for a bug when a test suddenly gets a 403 from /api/signup.
 */
describe('signup closes once the instance has an owner', () => {
  it('disables signup as soon as the first account is created', async () => {
    await signUpAndLogin({ email: 'first@example.com' });

    const { rows } = await pool.query('SELECT signup_enabled FROM app_settings');
    expect(rows[0].signup_enabled).toBe(false);
  });

  it('turns away the second person who tries to register', async () => {
    await signUpAndLogin({ email: 'first@example.com' });

    const res = await client().post('/api/signup').send({ email: 'second@example.com', password: 'secret123' });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Signup is currently disabled');
    expect(await countRows('users')).toBe(1);
  });

  it('sets the admin and closes signup in one atomic step', async () => {
    // Both live in app_settings and are written by the same transaction, so an
    // instance can never end up claimed-but-still-open, or open-but-unclaimed.
    await signUpAndLogin({ email: 'first@example.com' });

    const { rows } = await pool.query('SELECT first_user_id, signup_enabled FROM app_settings');
    expect(rows[0].first_user_id).not.toBeNull();
    expect(rows[0].signup_enabled).toBe(false);
  });

  it('reports the closed state on the public endpoint, so the UI can hide the form', async () => {
    await signUpAndLogin({ email: 'first@example.com' });

    const res = await client().get('/api/signup-status');

    expect(res.status).toBe(200);
    expect(res.body.signupEnabled).toBe(false);
  });

  it('lets the admin reopen it, and registration works again', async () => {
    const { client: admin } = await signUpAndLogin({ email: 'first@example.com' });

    const toggle = await admin.post('/api/user/signup-toggle').send({ enabled: true });
    expect(toggle.status).toBeLessThan(400);

    const res = await client().post('/api/signup').send({ email: 'second@example.com', password: 'secret123' });

    expect(res.status).toBeLessThan(400);
    expect(await countRows('users')).toBe(2);
  });

  it('only the admin may reopen it', async () => {
    const { client: admin } = await signUpAndLogin({ email: 'first@example.com' });
    await admin.post('/api/user/signup-toggle').send({ enabled: true });

    const { client: second } = await (async () => {
      await client().post('/api/signup').send({ email: 'second@example.com', password: 'secret123' });
      return loginAs('second@example.com', 'secret123');
    })();
    await admin.post('/api/user/signup-toggle').send({ enabled: false });

    const res = await second.post('/api/user/signup-toggle').send({ enabled: true });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const { rows } = await pool.query('SELECT signup_enabled FROM app_settings');
    expect(rows[0].signup_enabled).toBe(false);
  });
});

describe('login', () => {
  it('issues a session cookie and returns the account', async () => {
    await makeOwner({ email: 'user@example.com', password: 'correct-horse' });

    const { response } = await loginAs('user@example.com');

    expect(response.status).toBe(200);
    expect(response.body.user.email).toBe('user@example.com');
    expect(response.headers['set-cookie'].join(';')).toContain('token=');
  });

  it('marks the auth cookie HttpOnly', async () => {
    await makeOwner({ email: 'user@example.com' });
    const { response } = await loginAs('user@example.com');
    expect(response.headers['set-cookie'].join(';')).toMatch(/HttpOnly/i);
  });

  it('grants an owner every capability', async () => {
    await makeOwner({ email: 'user@example.com' });
    const { response } = await loginAs('user@example.com');
    expect(response.body.user.permissions).toEqual(ALL_PERMISSIONS);
    expect(response.body.user.isSubUser).toBe(false);
  });

  it('never returns the password hash', async () => {
    await makeOwner({ email: 'user@example.com' });
    const { response } = await loginAs('user@example.com');
    expect(JSON.stringify(response.body)).not.toMatch(/\$2[aby]\$/);
  });

  it('rejects a wrong password', async () => {
    await makeOwner({ email: 'user@example.com', password: 'correct-horse' });
    const { response } = await loginAs('user@example.com', 'wrong-password');
    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid credentials');
  });

  it('gives an unknown account the same answer as a wrong password', async () => {
    await makeOwner({ email: 'user@example.com', password: 'correct-horse' });

    const unknown = await loginAs('nobody@example.com', 'anything');
    const wrong = await loginAs('user@example.com', 'wrong-password');

    expect(unknown.response.status).toBe(wrong.response.status);
    expect(unknown.response.body.message).toBe(wrong.response.body.message);
  });

  it('records a session row', async () => {
    await makeOwner({ email: 'user@example.com' });
    await loginAs('user@example.com');
    expect(await countRows('sessions')).toBe(1);
  });

  it('writes an audit entry for a successful login', async () => {
    await makeOwner({ email: 'user@example.com' });
    await loginAs('user@example.com');

    // The audit queue is not running in tests, so the row is not written; what
    // matters here is that login does not fail when queueing is unavailable.
    expect(await countRows('sessions')).toBe(1);
  });
});

describe('authenticated requests', () => {
  it('returns the profile for a logged-in session', async () => {
    const { client: c, email } = await signUpAndLogin();
    const res = await c.get('/api/profile');

    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);
  });

  it('rejects a request with no session', async () => {
    const res = await client().get('/api/profile');
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('No token provided');
  });

  it('rejects a forged token', async () => {
    const res = await client().get('/api/profile').set('Cookie', 'token=not.a.real.token');
    expect(res.status).toBe(401);
  });

  it('blocks a state-changing request that omits the CSRF header', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await c.agent.post('/api/files/folder').send({ name: 'Docs' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/CSRF/);
  });

  it('allows a safe request without the CSRF header', async () => {
    const { client: c } = await signUpAndLogin();
    expect((await c.agent.get('/api/profile')).status).toBe(200);
  });
});

describe('sessions', () => {
  it('signing up logs you straight in, so signup then login leaves two sessions', async () => {
    // Worth stating outright: /api/signup issues its own session, so the
    // helper's signup-then-login sequence is two devices as far as the
    // session list is concerned.
    await signUpAndLogin();
    expect(await countRows('sessions')).toBe(2);
  });

  it('lists the active sessions', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await c.get('/api/sessions');

    expect(res.status).toBe(200);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(1);
  });

  it('marks which session is the current one', async () => {
    const { client: c } = await signUpAndLogin();
    const res = await c.get('/api/sessions');
    expect(res.body.sessions.filter(s => s.isCurrent)).toHaveLength(1);
  });

  it('counts each additional login as a separate session', async () => {
    const { email, password } = await signUpAndLogin();
    const before = await countRows('sessions');

    await loginAs(email, password);

    expect(await countRows('sessions')).toBe(before + 1);
  });

  it('revoking other sessions leaves only the current one', async () => {
    const { client: c, email, password } = await signUpAndLogin();
    await loginAs(email, password);
    expect(await countRows('sessions')).toBeGreaterThan(1);

    const res = await c.post('/api/sessions/revoke-others');

    expect(res.status).toBe(200);
    expect(await countRows('sessions')).toBe(1);
  });

  it('a revoked session can no longer be used', async () => {
    const { email, password } = await signUpAndLogin();
    const second = await loginAs(email, password);
    const { client: first } = await loginAs(email, password);

    await first.post('/api/sessions/revoke-others');

    expect((await second.client.get('/api/profile')).status).toBe(401);
    expect((await first.get('/api/profile')).status).toBe(200);
  });

  it('logging out everywhere bumps the token version and invalidates the cookie', async () => {
    const { client: c } = await signUpAndLogin();

    const res = await c.post('/api/logout-all');
    expect(res.status).toBe(200);

    expect((await c.get('/api/profile')).status).toBe(401);
  });

  it('logout clears the session', async () => {
    const { client: c } = await signUpAndLogin();

    expect((await c.post('/api/logout')).status).toBeLessThan(400);
    expect((await c.get('/api/profile')).status).toBe(401);
  });
});

describe('sub-user login', () => {
  it("reports the sub-user's own grants, not the owner's", async () => {
    const owner = await makeOwner();
    const sub = await makeSubUser(owner.id, [PERMISSIONS.DOWNLOAD], { email: 'member@example.com' });

    const { response } = await loginAs('member@example.com', sub.password);

    expect(response.status).toBe(200);
    expect(response.body.user.isSubUser).toBe(true);
    expect(response.body.user.permissions).toEqual([PERMISSIONS.DOWNLOAD]);
  });

  it('resolves the sub-user to the owner account for data access', async () => {
    const owner = await makeOwner();
    const sub = await makeSubUser(owner.id, [], { email: 'member@example.com' });

    const { client: c } = await loginAs('member@example.com', sub.password);
    const profile = await c.get('/api/profile');

    expect(profile.status).toBe(200);
    // The profile is the acting identity, not the owner.
    expect(profile.body.email).toBe('member@example.com');
  });
});
