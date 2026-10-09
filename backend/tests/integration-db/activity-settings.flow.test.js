/**
 * Session timeout and access-time settings end to end: only the first user may
 * read or change them, a change applies to existing sessions at once without a
 * restart, the database refuses out-of-range values, and session cleanup
 * follows the idle window rather than the age of a login.
 */

import { afterEach, describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { getActivitySettings, resetActivitySettings } from '../../config/activitySettings.js';
import { cleanupOldSessions } from '../../models/session.model.js';
import { createAndLogin, ensureOwner, loginAs } from './helpers/app.js';

afterEach(() => resetActivitySettings());

/** Pretend the user's sessions were last used `days` ago. */
async function idleFor(userId, days) {
  await pool.query(`UPDATE sessions SET last_activity = NOW() - INTERVAL '1 day' * $2 WHERE user_id = $1`, [
    userId,
    days,
  ]);
}

describe('who may manage the settings', () => {
  it('shows the defaults to the first user', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.get('/api/user/activity-config');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionIdleDays: 30,
      accessTimeTracking: true,
      accessTimeWindowMinutes: 60,
      accessTimeFlushSeconds: 10,
    });
  });

  it('refuses every other account, for reading and for writing', async () => {
    await ensureOwner();
    const { client: other } = await createAndLogin();

    expect((await other.get('/api/user/activity-config')).status).toBe(403);
    expect((await other.put('/api/user/session-timeout-config').send({ idleDays: 365 })).status).toBe(403);
    expect(
      (await other.put('/api/user/access-time-config').send({ enabled: false, windowMinutes: 0, flushSeconds: 1 }))
        .status
    ).toBe(403);

    const { rows } = await pool.query(`SELECT session_idle_days, access_time_tracking FROM app_settings`);
    expect(rows[0]).toEqual({ session_idle_days: 30, access_time_tracking: true });
  });
});

describe('saving', () => {
  it('stores the session timeout and applies it in this process', async () => {
    const { client: admin } = await ensureOwner();

    const res = await admin.put('/api/user/session-timeout-config').send({ idleDays: 7 });

    expect(res.status).toBe(200);
    expect(res.body.sessionIdleDays).toBe(7);
    expect(getActivitySettings().sessionIdleDays).toBe(7);
    const { rows } = await pool.query(`SELECT session_idle_days FROM app_settings`);
    expect(rows[0].session_idle_days).toBe(7);
  });

  it('stores the access-time settings and leaves the session timeout alone', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/session-timeout-config').send({ idleDays: 14 });

    const res = await admin
      .put('/api/user/access-time-config')
      .send({ enabled: false, windowMinutes: 1440, flushSeconds: 60 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sessionIdleDays: 14,
      accessTimeTracking: false,
      accessTimeWindowMinutes: 1440,
      accessTimeFlushSeconds: 60,
    });
  });

  it('rejects values outside the ranges before they reach the database', async () => {
    const { client: admin } = await ensureOwner();

    expect((await admin.put('/api/user/session-timeout-config').send({ idleDays: 0 })).status).toBe(422);
    expect(
      (await admin.put('/api/user/access-time-config').send({ enabled: true, windowMinutes: 60, flushSeconds: 0 }))
        .status
    ).toBe(422);
  });

  it('has the database refuse an out-of-range value written around the API', async () => {
    await expect(pool.query(`UPDATE app_settings SET session_idle_days = 0`)).rejects.toThrow(
      /app_settings_activity_ranges/
    );
    await expect(pool.query(`UPDATE app_settings SET access_time_flush_seconds = 301`)).rejects.toThrow(
      /app_settings_activity_ranges/
    );
  });
});

describe('the idle timeout on existing sessions', () => {
  it('ends a session idle longer than a shortened timeout', async () => {
    const { client: admin } = await ensureOwner();
    const { client: other, user: otherUser } = await createAndLogin();
    await admin.put('/api/user/session-timeout-config').send({ idleDays: 1 });

    await idleFor(otherUser.id, 2);

    expect((await other.get('/api/user/storage')).status).toBe(401);
    // The admin's own session was just used, so it stays.
    expect((await admin.get('/api/user/storage')).status).toBe(200);
  });

  it('keeps the same idle session once the timeout is long enough again', async () => {
    const { client: admin } = await ensureOwner();
    const { client: other, user: otherUser } = await createAndLogin();
    await admin.put('/api/user/session-timeout-config').send({ idleDays: 1 });
    await idleFor(otherUser.id, 2);
    expect((await other.get('/api/user/storage')).status).toBe(401);

    await admin.put('/api/user/session-timeout-config').send({ idleDays: 30 });

    expect((await other.get('/api/user/storage')).status).toBe(200);
  });

  it('issues cookies that last as long as the timeout', async () => {
    const { client: admin } = await ensureOwner();
    await admin.put('/api/user/session-timeout-config').send({ idleDays: 7 });

    const { email, password } = await createAndLogin();
    const { response } = await loginAs(email, password);
    const cookie = response.headers['set-cookie'].find(c => c.startsWith('token='));

    expect(cookie).toMatch(new RegExp(`Max-Age=${7 * 24 * 60 * 60}(;|$)`));
  });
});

describe('session cleanup', () => {
  it('deletes idle-expired sessions and sessions from before a log-out-everywhere', async () => {
    const { user: owner } = await ensureOwner();
    const { user: idle } = await createAndLogin();
    const { user: loggedOut } = await createAndLogin();
    await pool.query(`UPDATE app_settings SET session_idle_days = 7`);
    await idleFor(idle.id, 8);
    await pool.query(`UPDATE users SET token_version = token_version + 1 WHERE id = $1`, [loggedOut.id]);

    await cleanupOldSessions();

    const { rows } = await pool.query(`SELECT DISTINCT user_id FROM sessions`);
    expect(rows.map(r => r.user_id)).toEqual([owner.id]);
  });

  it('keeps an active session however long ago it logged in', async () => {
    const { user } = await ensureOwner();
    await pool.query(`UPDATE sessions SET created_at = NOW() - INTERVAL '400 days' WHERE user_id = $1`, [user.id]);

    const before = (await pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [user.id])).rowCount;

    await cleanupOldSessions();

    expect(before).toBeGreaterThan(0);
    expect((await pool.query(`SELECT 1 FROM sessions WHERE user_id = $1`, [user.id])).rowCount).toBe(before);
  });
});
