// Load environment variables FIRST before any other imports
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const fs = require('fs');
const pool = require('./config/db');
const authRoutes = require('./routes/auth.routes');
const fileRoutes = require('./routes/file.routes');
const shareRoutes = require('./routes/share.routes');
const onlyofficeRoutes = require('./routes/onlyoffice.routes');
const userRoutes = require('./routes/user.routes');
const versionRoutes = require('./routes/version.routes');
const publicRoutes = require('./routes/public.routes');
const { startTrashCleanup } = require('./services/trashCleanup');

const { startAuditCleanup } = require('./services/auditCleanup');
const { startOrphanFileCleanup } = require('./services/orphanCleanup');
const { startShareCleanup } = require('./services/shareCleanup');
const errorHandler = require('./middleware/error.middleware');
// Logging and audit system
const { requestIdMiddleware } = require('./middleware/requestId.middleware');
const { blockMainAppOnShareDomain } = require('./middleware/shareDomain.middleware');
const { logger, httpLogger } = require('./config/logger');
const { initializeAuditQueue, shutdownAuditQueue } = require('./services/auditLogger');
const { initializeMetrics, metricsEndpoint, startQueueMetricsUpdater } = require('./services/metrics');
const { connectRedis, disconnectRedis } = require('./config/redis');

const app = express();

// Metrics endpoint IP whitelist
const METRICS_ALLOWED_IPS = (process.env.METRICS_ALLOWED_IPS || '127.0.0.1').split(',').map(ip => ip.trim());

// Import OnlyOffice origin cache utility
const { getCachedOnlyOfficeOrigin } = require('./utils/onlyofficeOriginCache');

// FIRST: Request ID middleware (must be first for proper context propagation)
app.use(requestIdMiddleware);

// Block main app access on share domain (must be very early, before logging and JSON parsing)
// This stops requests immediately without logging or processing body
app.use(blockMainAppOnShareDomain);

// SECOND: HTTP request logging (after requestId so it can use it, after blocking so blocked requests aren't logged)
app.use(httpLogger);

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Allow ONLYOFFICE Document Server for scripts / connections / iframes, if configured
  let scriptSrc = "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
  let connectSrc = "connect-src 'self'";
  let frameSrc = "frame-src 'self'";

  // Get OnlyOffice origin from in-memory cache (synchronous, 60s TTL)
  // Uses stale-while-revalidate pattern: returns cached value immediately, refreshes in background if expired
  const onlyofficeOrigin = getCachedOnlyOfficeOrigin();
  if (onlyofficeOrigin) {
    scriptSrc += ` ${onlyofficeOrigin}`;
    connectSrc += ` ${onlyofficeOrigin}`;
    frameSrc += ` ${onlyofficeOrigin}`;
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
    "form-action 'self'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  next();
});

app.use(express.json({ limit: '10mb' }));

// Health check endpoint (before auth, for monitoring)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Metrics endpoint (protected by IP whitelist in all envs)
app.get(
  '/metrics',
  (req, res, next) => {
    if (!METRICS_ALLOWED_IPS.includes(req.ip)) {
      logger.warn({ ip: req.ip }, 'Unauthorized metrics access attempt');
      return res.status(403).send('Forbidden');
    }
    next();
  },
  metricsEndpoint
);

// API routes
app.use('/api', publicRoutes);
app.use('/api', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/user', userRoutes);
app.use('/api/onlyoffice', onlyofficeRoutes);
app.use('/api/version', versionRoutes);
app.use('/s', shareRoutes);

// Serve static frontend files (only when frontend is built)
const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
const frontendExists = fs.existsSync(frontendPath) && fs.existsSync(path.join(frontendPath, 'index.html'));

if (frontendExists) {
  app.use(express.static(frontendPath));
  // SPA fallback - serve index.html for all non-API routes
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/s')) {
      return next();
    }
    res.sendFile(path.join(frontendPath, 'index.html'), err => {
      if (err) next(err);
    });
  });
} else {
  logger.warn('Frontend not built (frontend/dist missing). Non-API routes will return a graceful 404.');
  // Graceful response when frontend is missing - no ENOENT, no stack traces
  app.use((req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/s')) {
      return next();
    }
    res.status(404).json({
      message: 'Frontend not available. Build the frontend.',
      error: 'FRONTEND_NOT_BUILT',
    });
  });
}

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
    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const version = file.replace('.sql', '');
      if (!applied.includes(version)) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        logger.info({ version }, 'Applying migration');
        await client.query(sql);
        await client.query('INSERT INTO migrations(version) VALUES($1)', [version]);
      }
    }
  } finally {
    client.release();
  }
}

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

  try {
    // Stop accepting new connections
    if (server) {
      server.close(() => {
        logger.info('HTTP server closed');
      });
    }

    // Shutdown audit queue
    await shutdownAuditQueue();

    // Disconnect Redis
    await disconnectRedis();

    // Close database pool
    await pool.end();
    logger.info('Database pool closed');

    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

// Store server instance for graceful shutdown
let server = null;

// Handle unhandled promise rejections (log only; do not exit in any env)
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection');
});

// Handle uncaught exceptions
process.on('uncaughtException', error => {
  logger.error({ err: error }, 'Uncaught Exception');
  // Always exit on uncaught exceptions as the application is in an undefined state
  process.exit(1);
});

runMigrations()
  .then(async () => {
    const port = process.env.BPORT || 3000;

    // Initialize Redis connection
    try {
      await connectRedis();
    } catch (error) {
      logger.error({ err: error }, 'Failed to connect to Redis - continuing without cache');
      // Continue anyway - Redis is optional for graceful degradation
    }

    // Initialize audit system
    try {
      await initializeAuditQueue();
      logger.info('Audit queue initialized');

      initializeMetrics();
      logger.info('Metrics initialized');

      // Start queue metrics updater (every 30 seconds)
      startQueueMetricsUpdater(30);
      logger.info('Queue metrics updater started');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize audit system');
      // Continue anyway - audit system is non-critical for application operation
    }

    // Start HTTP server
    server = app.listen(port, () => {
      logger.info({ port, environment: process.env.NODE_ENV || 'development' }, 'Server started successfully');
    });

    // Start background services
    startTrashCleanup();

    startAuditCleanup();

    startOrphanFileCleanup();

    startShareCleanup();

    // Register shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  })
  .catch(err => {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  });
