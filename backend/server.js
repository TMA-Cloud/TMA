const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pool = require('./config/db');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const appliedRes = await client.query('SELECT version FROM migrations');
    const applied = appliedRes.rows.map(r => r.version);
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;
    const files = fs.readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const version = file.replace('.sql', '');
      if (!applied.includes(version)) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        console.log(`Applying migration ${version}`);
        await client.query(sql);
        await client.query('INSERT INTO migrations(version) VALUES($1)', [version]);
      }
    }
  } finally {
    client.release();
  }
}

app.get('/api/files', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files'
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

runMigrations()
  .then(() => {
    const port = process.env.PORT || 3000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
  })
  .catch((err) => {
    console.error('Failed to run migrations', err);
    process.exit(1);
  });
