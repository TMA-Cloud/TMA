/**
 * Integration setup: real Postgres, real Redis, in-memory bucket storage.
 *
 * Guardrails, because this connects to live infrastructure:
 *   - refuses to run unless the database name ends in `_test`
 *   - refuses to run against Redis database 0 (the dev cache)
 *   - replaces bucket storage with an isolated in-memory double
 *
 * The schema is built by the project's own migrations, so the tests exercise
 * exactly the DDL that production runs.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterAll, beforeAll, beforeEach } from 'vitest';

import pool from '../../config/db.js';
import { resetStorageMock } from '../mocks/storage.mock.js';
import { connectRedis, disconnectRedis, redisClient } from '../../config/redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/* ------------------------------------------------------------------ *
 * Guardrails
 * ------------------------------------------------------------------ */

if (!/_test$/.test(process.env.DB_NAME || '')) {
  throw new Error(
    `Refusing to run integration tests against database "${process.env.DB_NAME}". ` +
      'The name must end in "_test" so a working database is never truncated.'
  );
}

if (String(process.env.REDIS_DB || '0') === '0') {
  throw new Error('Refusing to run integration tests against Redis database 0. Set REDIS_DB to a scratch database.');
}

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/** Apply every migration that has not been recorded yet, exactly as server.js does. */
async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const applied = (await client.query('SELECT version FROM migrations')).rows.map(r => r.version);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter(f => f.endsWith('.sql'))
      .sort();

    for (const file of files) {
      const version = file.replace('.sql', '');
      if (applied.includes(version)) continue;
      await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('INSERT INTO migrations(version) VALUES($1)', [version]);
    }
  } finally {
    client.release();
  }
}

/** Every table holding test data. `migrations` is deliberately absent. */
const DATA_TABLES = [
  'audit_log',
  'client_heartbeats',
  'mfa_backup_codes',
  'sessions',
  'share_link_files',
  'share_links',
  'files',
  'app_settings',
  'users',
];

async function truncateAll() {
  await pool.query(`TRUNCATE TABLE ${DATA_TABLES.map(t => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  // Migration 012 seeds this row; the app assumes it exists.
  await pool.query(
    `INSERT INTO app_settings (id, signup_enabled) VALUES ('app_settings', true) ON CONFLICT (id) DO NOTHING`
  );
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

beforeAll(async () => {
  await connectRedis();
  await runMigrations();
});

beforeEach(async () => {
  await truncateAll();
  resetStorageMock();
  // Caches key off user ids, which are regenerated per test; a stale entry
  // would otherwise be served to a brand new account with the same key shape.
  if (redisClient.isReady) {
    await redisClient.flushDb();
  }
});

afterAll(async () => {
  await disconnectRedis().catch(() => {});
  await pool.end().catch(() => {});
});

export { runMigrations, truncateAll, DATA_TABLES };
