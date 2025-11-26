const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const pool = require('./config/db');
const authRoutes = require('./routes/auth.routes');
const fileRoutes = require('./routes/file.routes');
const shareRoutes = require('./routes/share.routes');
const onlyofficeRoutes = require('./routes/onlyoffice.routes');
const userRoutes = require('./routes/user.routes');
const { startTrashCleanup } = require('./services/trashCleanup');
const { startOrphanFileCleanup } = require('./services/orphanCleanup');
const { startCustomDriveScanner } = require('./services/customDriveScanner');
const errorHandler = require('./middleware/error.middleware');
require('dotenv').config();

const app = express();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), location=()');

  // Allow ONLYOFFICE Document Server for scripts / connections / iframes, if configured
  let scriptSrc = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  let connectSrc = "connect-src 'self'";
  let frameSrc = "frame-src 'self'";
  const onlyofficeBase = process.env.ONLYOFFICE_URL;
  if (onlyofficeBase) {
    try {
      const onlyofficeOrigin = new URL(onlyofficeBase).origin;
      scriptSrc += ` ${onlyofficeOrigin}`;
      connectSrc += ` ${onlyofficeOrigin}`;
      frameSrc += ` ${onlyofficeOrigin}`;
    } catch {
      // ignore invalid URL, fall back to strict defaults
    }
  }

  // Content Security Policy - allow only necessary sources
  const csp = [
    "default-src 'self'",
    scriptSrc, // unsafe-inline/eval needed for some frameworks
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    connectSrc,
    frameSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  next();
});

const corsOptions = {
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use('/api', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/user', userRoutes);
app.use('/api/onlyoffice', onlyofficeRoutes);
app.use('/s', shareRoutes);

// Error handling middleware (must be last)
app.use(errorHandler);

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


runMigrations()
  .then(() => {
    const port = process.env.BPORT || 3000;
    app.listen(port, () => console.log(`Server running on port ${port}`));
    startTrashCleanup();
    startOrphanFileCleanup();
    startCustomDriveScanner();
  })
  .catch((err) => {
    console.error('Failed to run migrations', err);
    process.exit(1);
  });
