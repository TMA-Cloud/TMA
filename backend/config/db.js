import pg from 'pg';

import { parseDatabaseUrl } from '../utils/connectionUrl.js';

import { logger } from './logger.js';

const { Pool } = pg;

// Parsed once: an sslrootcert in the URL is read from disk on every parse.
const urlConfig = parseDatabaseUrl(process.env.DATABASE_URL);

/**
 * The pg connection config from DATABASE_URL. Callers can override or extend
 * it (e.g. max pool size, a password to test).
 */
function buildPoolConfig(overrides = {}) {
  return { ...urlConfig, ...overrides };
}

/** The pg-boss schema as a quoted SQL identifier, shared by every consumer. */
const pgbossSchema = '"pgboss"';

/** Create a new pg Pool with the shared env-driven config. */
function createPool(overrides = {}) {
  return new Pool(buildPoolConfig(overrides));
}

const pool = createPool();

// Error handling
pool.on('error', (err, _client) => {
  logger.error({ err }, 'Unexpected error on idle database client');
});

// Connection test
pool.connect((err, client, release) => {
  if (err) {
    logger.error({ err }, 'Failed to acquire database client');
    return;
  }
  if (!client) {
    logger.error('Database client is null after successful connect');
    return;
  }
  logger.info('Database connected successfully');
  client.query('SELECT NOW()', (queryErr, _result) => {
    release();
    if (queryErr) {
      logger.error({ err: queryErr }, 'Database query test failed');
      return;
    }
    logger.debug('Database query test successful');
  });
});

export { createPool, buildPoolConfig, pgbossSchema };
export default pool;
