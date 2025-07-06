require('dotenv').config();

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'cloud_storage',
  ssl: process.env.DB_SSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

// Error handling
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
});

// Connection test
pool.connect((err, client, release) => {
  if (err) {
    console.error('Error acquiring client', err.stack);
    return;
  }
  console.log('Database connected successfully');
  client.query('SELECT NOW()', (err, result) => {
    release();
    if (err) {
      console.error('Error executing query', err.stack);
      return;
    }
    console.log('Database query test successful');
  });
});

module.exports = pool;
