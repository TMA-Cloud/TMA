const { Pool } = require('pg');
const { logger } = require('./logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'cloud_store',
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
  logger.info('Database connected successfully');
  client.query('SELECT NOW()', (err, _result) => {
    release();
    if (err) {
      logger.error({ err }, 'Database query test failed');
      return;
    }
    logger.debug('Database query test successful');
  });
});

module.exports = pool;
