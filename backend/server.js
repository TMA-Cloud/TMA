import './config/env.js';

import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import express from 'express';

import pool from './config/db.js';
import authRoutes from './routes/auth.routes.js';
import fileRoutes from './routes/file.routes.js';
import shareRoutes from './routes/share.routes.js';
import onlyofficeRoutes from './routes/onlyoffice.routes.js';
import userRoutes from './routes/user.routes.js';
import versionRoutes from './routes/version.routes.js';
import publicRoutes from './routes/public.routes.js';

import { csrfProtection } from './middleware/csrf.middleware.js';
import errorHandler from './middleware/error.middleware.js';
import { requestIdMiddleware } from './middleware/requestId.middleware.js';
import { blockMainAppOnShareDomain } from './middleware/shareDomain.middleware.js';
import { requireElectronClientIfEnabled } from './middleware/electronClient.middleware.js';
import { logger, httpLogger } from './config/logger.js';
import { initializeAuditQueue, shutdownAuditQueue } from './services/auditLogger.js';
import { configureAccessTracker, shutdownAccessTracker } from './services/accessTracker.js';
import { startActivitySettings, stopActivitySettings } from './config/activitySettings.js';
import { initializeMetrics, metricsEndpoint, startQueueMetricsUpdater } from './services/metrics.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { getKnownProxiesSettings, loadActivitySettings } from './models/user.model.js';
import { verifyEncryptionKeys } from './services/encryptionKeyCheck.js';
import { resolveKnownProxies } from './utils/knownProxies.js';

import { getCachedOnlyOfficeOrigin, warmOnlyOfficeOriginCache } from './utils/onlyofficeOriginCache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Metrics endpoint IP whitelist
const METRICS_ALLOWED_IPS = (process.env.METRICS_ALLOWED_IPS || '127.0.0.1,::ffff:127.0.0.1,::1')
  .split(',')
  .map(ip => ip.trim());

// FIRST: Request ID middleware (must be first for proper context propagation)
app.use(requestIdMiddleware);

// Block main app on the share domain — very early, before logging/body parsing.
app.use(blockMainAppOnShareDomain);

// Optionally require the Electron client (admin toggle); early so blocks are cheap.
app.use(requireElectronClientIfEnabled);

// HTTP request logging (after requestId and blocking, so blocked requests aren't logged).
app.use(httpLogger);

// The SPA's index.html is static, so its one inline script (the theme
// bootstrap) is allowed by hash; server-rendered pages get a per-request nonce.
const spaInlineScriptHashes = (() => {
  try {
    const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'), 'utf8');
    return [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
      m => `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`
    );
  } catch {
    return [];
  }
})();

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // OWASP: turn the legacy XSS auditor off; it can be abused and CSP replaces it.
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');

  // Allow ONLYOFFICE Document Server for scripts / connections / iframes, if configured
  // No 'unsafe-inline'/'unsafe-eval': with them CSP could not stop an injected script.
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.cspNonce = nonce;
  let scriptSrc = ["script-src 'self'", `'nonce-${nonce}'`, ...spaInlineScriptHashes].join(' ');
  let connectSrc = "connect-src 'self'";
  let frameSrc = "frame-src 'self'";

  const onlyofficeOrigin = getCachedOnlyOfficeOrigin();
  if (onlyofficeOrigin) {
    scriptSrc += ` ${onlyofficeOrigin}`;
    connectSrc += ` ${onlyofficeOrigin}`;
    frameSrc += ` ${onlyofficeOrigin}`;
  }

  const csp = [
    "default-src 'self'",
    scriptSrc,
    "object-src 'none'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    connectSrc,
    frameSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  res.setHeader('Content-Security-Policy', csp);

  next();
});

app.use(express.json({ limit: '1mb' }));

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

// API routes. CSRF-exempt routes (public, OnlyOffice callbacks, version) are
// registered before the csrfProtection-bearing lines so they respond first.
app.use('/api', publicRoutes);
app.use('/api/onlyoffice', onlyofficeRoutes);
app.use('/api/version', versionRoutes);
app.use('/api', csrfProtection, authRoutes);
app.use('/api/files', csrfProtection, fileRoutes);
app.use('/api/user', csrfProtection, userRoutes);
app.use('/s', shareRoutes);

// A bare startsWith('/s') also swallowed SPA paths like /settings or /shared.
const isBackendPath = p => p === '/api' || p.startsWith('/api/') || p === '/s' || p.startsWith('/s/');

// Serve static frontend files (only when frontend is built)
const frontendPath = path.join(__dirname, '..', 'frontend', 'dist');
const frontendExists = fs.existsSync(frontendPath) && fs.existsSync(path.join(frontendPath, 'index.html'));

if (frontendExists) {
  app.use(express.static(frontendPath));
  // SPA fallback - serve index.html for all non-API routes
  app.use((req, res, next) => {
    if (isBackendPath(req.path)) {
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
    if (isBackendPath(req.path)) {
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

// Arbitrary constant: serialises migrations across replicas starting together.
const MIGRATION_LOCK_KEY = 7_261_900_001;

async function runMigrations() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS migrations (
      version VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const appliedRes = await client.query('SELECT version FROM migrations');
    const applied = new Set(appliedRes.rows.map(r => r.version));
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;
    const files = fs
      .readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const version = file.replace('.sql', '');
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      logger.info({ version }, 'Applying migration');
      // One transaction, so a crash can't leave a migration applied but unrecorded.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations(version) VALUES($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

const SHUTDOWN_DRAIN_MS = 8000;

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

  try {
    // Let in-flight requests finish before the pool closes under them; SSE
    // streams never end on their own, so cut stragglers under Docker's 10s grace.
    if (server) {
      await new Promise(resolve => {
        server.close(() => {
          logger.info('HTTP server closed');
          resolve();
        });
        server.closeIdleConnections();
        setTimeout(() => {
          server.closeAllConnections();
          resolve();
        }, SHUTDOWN_DRAIN_MS).unref();
      });
    }

    // Shutdown audit queue
    await shutdownAuditQueue();

    // Shutdown access tracker
    stopActivitySettings();
    await shutdownAccessTracker();

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

    // A wrong master key must stop startup, not surface later as undecryptable files.
    await verifyEncryptionKeys();

    // Forwarded headers affect authentication logs and rate limits, so only
    // enable them for explicitly configured proxy addresses.
    const configuredProxies = await getKnownProxiesSettings();
    const { resolved: trustedProxies, failures } = await resolveKnownProxies(configuredProxies);
    app.set('trust proxy', trustedProxies.length > 0 ? trustedProxies : false);
    if (failures.length > 0) {
      logger.warn({ hostnames: failures }, 'Some known proxy hostnames could not be resolved and will not be trusted');
    }
    logger.info(
      { configuredCount: configuredProxies.length, trustedAddressCount: trustedProxies.length },
      'Known proxy trust configured'
    );

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

      // This gauge belongs to the HTTP process that exposes /metrics.
      startQueueMetricsUpdater();
      logger.info('Queue metrics updater started');
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize audit system');
      // Continue anyway - audit system is non-critical for application operation
    }

    // Warm the OnlyOffice origin cache before accepting requests so the first
    // page loads get a CSP that allows the OnlyOffice API script. Otherwise the
    // cold cache returns null synchronously and api.js is blocked until a reload.
    try {
      await warmOnlyOfficeOriginCache();
      logger.info('OnlyOffice origin cache warmed');
    } catch (error) {
      logger.warn({ err: error }, 'Failed to warm OnlyOffice origin cache - will populate on first request');
    }

    // The session timeout applies from the first request, so load it before listening.
    // Access tracking buffers request-local activity in this process and
    // follows its settings as they change.
    await startActivitySettings(loadActivitySettings, next => configureAccessTracker(next));

    // Start HTTP server
    server = app.listen(port, () => {
      logger.info({ port, environment: process.env.NODE_ENV || 'development' }, 'Server started successfully');
    });

    // Register shutdown handlers
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  })
  .catch(err => {
    logger.error({ err }, 'Failed to start server');
    process.exit(1);
  });
