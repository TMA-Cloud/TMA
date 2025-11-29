const PgBoss = require('pg-boss');
const { logger } = require('../config/logger');
const { getRequestId, getUserId } = require('../middleware/requestId.middleware');

let boss = null;
let isInitialized = false;

const AUDIT_QUEUE = 'audit-events';

/**
 * Initialize pg-boss connection for audit event queueing
 *
 * This should be called once during application startup.
 * The boss instance is shared across all audit logging calls.
 *
 * @returns {Promise<PgBoss>} The initialized pg-boss instance
 */
async function initializeAuditQueue() {
  if (boss) {
    return boss;
  }

  try {
    boss = new PgBoss({
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432'),
      database: process.env.DB_NAME || 'cloud_store',
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      schema: 'pgboss',
      // Connection pool settings
      max: 10,
      // Archiving settings
      archiveCompletedAfterSeconds: 60 * 60 * 24, // Archive after 24 hours
      deleteArchivedJobsAfterDays: 30, // Delete archives after 30 days
      // Monitoring
      monitorStateIntervalSeconds: 60,
    });

    boss.on('error', (error) => {
      logger.error({ err: error }, 'pg-boss error');
    });

    await boss.start();
    isInitialized = true;
    logger.info('Audit queue initialized successfully');

    return boss;
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize audit queue');
    throw error;
  }
}

/**
 * Get the pg-boss instance
 * @returns {PgBoss|null}
 */
function getBoss() {
  return boss;
}

/**
 * Gracefully shut down the audit queue
 */
async function shutdownAuditQueue() {
  if (boss) {
    logger.info('Shutting down audit queue...');
    await boss.stop();
    boss = null;
    isInitialized = false;
    logger.info('Audit queue shut down successfully');
  }
}

/**
 * Redact sensitive data from audit event metadata
 *
 * Removes all sensitive information to prevent credential leakage in audit logs.
 * This includes JWTs, passwords, API keys, OAuth secrets, and other credentials.
 *
 * @param {Object} metadata - The metadata object to redact
 * @returns {Object} Redacted metadata
 */
function redactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  const redacted = { ...metadata };

  // Comprehensive list of sensitive keywords to redact
  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'authorization',
    'cookie',
    'jwt',
    'access_token',
    'refresh_token',
    'accesstoken',
    'refreshtoken',
    'apikey',
    'api_key',
    'client_secret',
    'clientsecret',
    'auth',
    'bearer',
    'connectionstring',
    'db_password',
    'jwt_secret',
    'google_client_secret',
    'onlyoffice_jwt_secret',
  ];

  for (const key of Object.keys(redacted)) {
    const lowerKey = key.toLowerCase();

    // Check if the key contains any sensitive keywords
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      redacted[key] = '[REDACTED]';
    }
    // Recursively redact nested objects
    else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactMetadata(redacted[key]);
    }
    // Partially mask email for privacy while keeping it useful for debugging
    else if (key === 'email' && typeof redacted[key] === 'string') {
      const email = redacted[key];
      const [local, domain] = email.split('@');
      if (local && domain) {
        const masked = local.charAt(0) + '***' + local.charAt(local.length - 1);
        redacted[key] = `${masked}@${domain}`;
      }
    }
  }

  return redacted;
}

/**
 * Log an audit event (fire-and-forget, async)
 *
 * This is the core function for audit logging. It:
 * 1. Enriches the event with context (requestId, userId, IP, userAgent)
 * 2. Redacts sensitive data
 * 3. Queues the event to pg-boss for async processing
 * 4. Falls back to application logging if queueing fails
 *
 * @param {string} action - The action being audited (e.g., 'file.upload', 'auth.login')
 * @param {Object} options - Audit event options
 * @param {string} [options.status='success'] - Event status: 'success', 'failure', 'error'
 * @param {string} [options.resourceType] - Type of resource (e.g., 'file', 'folder')
 * @param {string} [options.resourceId] - ID of the resource
 * @param {Object} [options.metadata] - Additional event-specific data
 * @param {string} [options.errorMessage] - Error message if status is 'error'
 * @param {number} [options.processingTimeMs] - Operation duration in milliseconds
 * @param {Object} req - Express request object (for extracting IP, userAgent, etc.)
 * @returns {Promise<void>}
 */
async function logAuditEvent(action, options = {}, req = null) {
  try {
    // Build audit event
    const event = {
      // Auto-populated from CLS context
      requestId: getRequestId() || req?.requestId || 'unknown',
      userId: getUserId() || req?.userId || null,

      // Action details
      action,
      resourceType: options.resourceType || null,
      resourceId: options.resourceId || null,
      status: options.status || 'success',

      // Request context (from Express req object)
      ipAddress: req?.ip || req?.socket?.remoteAddress || null,
      userAgent: req?.headers?.['user-agent'] || null,

      // Additional metadata (redacted)
      metadata: redactMetadata(options.metadata) || null,

      // Error tracking
      errorMessage: options.errorMessage || null,

      // Performance tracking
      processingTimeMs: options.processingTimeMs || null,
    };

    // Queue the event to pg-boss (fire-and-forget)
    if (!isInitialized || !boss) {
      logger.warn({ action, event }, 'Audit queue not initialized, logging to app logs only');
      return;
    }

    const jobId = await boss.send(
      AUDIT_QUEUE,
      event,
      {
        retryLimit: 3, // Retry up to 3 times
        retryDelay: 60, // Wait 60 seconds before first retry
        retryBackoff: true, // Exponential backoff (60s, 120s, 240s)
        expireInSeconds: 60 * 60 * 24, // Expire job after 24 hours
      }
    );

    logger.debug({ jobId, action }, 'Audit event queued');
  } catch (error) {
    // CRITICAL: Never let audit logging break the main application
    logger.error({ err: error, action, options }, 'Failed to queue audit event');
    // Fallback: Log to application log as backup
    logger.warn({ action, ...options }, 'Audit event logged to application log only');
  }
}

// ============================================================================
// Convenience methods for common audit events
// ============================================================================

/**
 * Log a file upload event
 */
async function fileUploaded(fileId, fileName, fileSize, req) {
  return logAuditEvent(
    'file.upload',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileName, fileSize },
    },
    req
  );
}

/**
 * Log a file download event
 */
async function fileDownloaded(fileId, fileName, req) {
  return logAuditEvent(
    'file.download',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileName },
    },
    req
  );
}

/**
 * Log a file delete event
 */
async function fileDeleted(fileId, fileName, permanent, req) {
  return logAuditEvent(
    permanent ? 'file.delete.permanent' : 'file.delete',
    {
      status: 'success',
      resourceType: 'file',
      resourceId: fileId,
      metadata: { fileName, permanent },
    },
    req
  );
}

/**
 * Log a successful login event
 */
async function loginSuccess(userId, email, req) {
  return logAuditEvent(
    'auth.login',
    {
      status: 'success',
      resourceType: 'auth',
      metadata: { email, method: 'password' },
    },
    req
  );
}

/**
 * Log a failed login attempt
 */
async function loginFailure(email, reason, req) {
  return logAuditEvent(
    'auth.login.failure',
    {
      status: 'failure',
      resourceType: 'auth',
      metadata: { email, reason },
    },
    req
  );
}

/**
 * Log a user signup event
 */
async function userSignup(userId, email, method, req) {
  return logAuditEvent(
    'auth.signup',
    {
      status: 'success',
      resourceType: 'user',
      resourceId: userId,
      metadata: { email, method },
    },
    req
  );
}

/**
 * Log a share link creation
 */
async function shareCreated(shareId, fileIds, req) {
  return logAuditEvent(
    'share.create',
    {
      status: 'success',
      resourceType: 'share',
      resourceId: shareId,
      metadata: { fileCount: fileIds.length },
    },
    req
  );
}

/**
 * Log a share link access (may be anonymous)
 */
async function shareAccessed(shareId, req) {
  return logAuditEvent(
    'share.access',
    {
      status: 'success',
      resourceType: 'share',
      resourceId: shareId,
    },
    req
  );
}

module.exports = {
  initializeAuditQueue,
  shutdownAuditQueue,
  getBoss,
  logAuditEvent,
  // Convenience methods
  fileUploaded,
  fileDownloaded,
  fileDeleted,
  loginSuccess,
  loginFailure,
  userSignup,
  shareCreated,
  shareAccessed,
};
