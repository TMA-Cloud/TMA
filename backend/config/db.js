import pg from 'pg';

import { logger } from './logger.js';

const { Pool } = pg;

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'tma_cloud_storage',
  ssl: process.env.DB_SSLMODE === 'require' ? { rejectUnauthorized: false } : false,
});

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

export default pool;
