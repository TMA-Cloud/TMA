import { describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { isRedisConnected, redisClient } from '../../config/redis.js';

describe('integration environment', () => {
  it('is pointed at a dedicated test database', async () => {
    const { rows } = await pool.query('SELECT current_database() AS db');
    expect(rows[0].db).toBe('tma_cloud_test');
    expect(rows[0].db).toMatch(/_test$/);
  });

  it('has applied every migration in the repository', async () => {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM migrations');
    expect(rows[0].c).toBeGreaterThanOrEqual(33);
  });

  it('has the full schema', async () => {
    const { rows } = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
    const tables = rows.map(r => r.table_name);
    for (const expected of ['users', 'files', 'sessions', 'share_links', 'app_settings', 'audit_log']) {
      expect(tables).toContain(expected);
    }
  });

  it('starts each test with an empty users table', async () => {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    expect(rows[0].c).toBe(0);
  });

  it('keeps the seeded app_settings row after truncation', async () => {
    const { rows } = await pool.query('SELECT id, signup_enabled FROM app_settings');
    expect(rows).toHaveLength(1);
    expect(rows[0].signup_enabled).toBe(true);
  });

  it('is connected to a scratch Redis database, not the dev one', async () => {
    expect(isRedisConnected()).toBe(true);
    expect(process.env.REDIS_DB).not.toBe('0');
    await redisClient.set('smoke', 'ok');
    expect(await redisClient.get('smoke')).toBe('ok');
  });
});
