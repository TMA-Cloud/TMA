import { PgBoss } from 'pg-boss';

import { logger } from '../../config/logger.js';
import { getRequestId, getUserId, getAccountContext } from '../../middleware/requestId.middleware.js';
import { createPool, buildPoolConfig, pgbossSchema } from '../../config/db.js';

import { AUDIT_QUEUE, AUDIT_QUEUE_OPTIONS } from '../auditQueue.js';

let boss = null;
let isInitialized = false;

// pg-boss enforces expiration strictly < 24h; clamp to a safe default.
const MAX_JOB_TTL_SECONDS = 60 * 60 * 24 - 60; // 23h 59m to stay under limit
const AUDIT_JOB_TTL_SECONDS = Math.min(
  parseInt(process.env.AUDIT_JOB_TTL_SECONDS || '82800', 10), // default 23h
  MAX_JOB_TTL_SECONDS
);

/**
 * Initialize the shared pg-boss connection. Call once at startup.
 * @returns {Promise<PgBoss>} The initialized pg-boss instance
 */
async function initializeAuditQueue() {
  if (boss) {
    return boss;
  }

  try {
    // Ensure schema exists before pg-boss migrations run
    const pool = createPool();
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${pgbossSchema}`);
    await pool.end();

    boss = new PgBoss({
      ...buildPoolConfig(),
      schema: pgbossSchema,
      max: 10,
      migrate: true, // build schema/tables
      archiveCompletedAfterSeconds: 60 * 60 * 24,
      deleteArchivedJobsAfterDays: 30,
      monitorStateIntervalSeconds: 60,
    });

    boss.on('error', error => {
      logger.error({ err: error }, 'pg-boss error');
    });

    await boss.start();
    // pg-boss v10+ requires queues to be created explicitly.
    await boss.createQueue(AUDIT_QUEUE, AUDIT_QUEUE_OPTIONS);
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
 * Redact credentials (JWTs, passwords, API keys, secrets) from audit metadata
 * so they never leak into logs.
 * @param {Object} metadata - The metadata object to redact
 * @returns {Object} Redacted metadata
 */
function redactMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return metadata;
  }

  const redacted = { ...metadata };

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

    if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
      redacted[key] = '[REDACTED]';
    } else if (typeof redacted[key] === 'object' && redacted[key] !== null) {
      redacted[key] = redactMetadata(redacted[key]);
    }
    // Partially mask emails — still useful for debugging.
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
 * Whether the actor was operating as the account owner or as one of its
 * sub-users. Recorded per row so the trail stays readable even after a
 * sub-user is deleted and the join in `audit_activity` no longer resolves.
 * @param {Object|null} account - CLS account context
 * @param {Object|null} req - Express request
 * @returns {string|null}
 */
function resolveActorRole(account, req) {
  const isSubUser = account?.isSubUser ?? req?.isSubUser;
  if (isSubUser === undefined || isSubUser === null) return null;
  return isSubUser ? 'sub_user' : 'owner';
}

/**
 * Log an audit event (fire-and-forget): enrich with request context, redact
 * secrets, and queue to pg-boss; falls back to app logs if queueing fails.
 * @param {string} action - The action being audited (e.g., 'file.upload')
 * @param {Object} options - status, resourceType, resourceId, metadata,
 *   errorMessage, processingTimeMs, actorUserId, accountOwnerId, actorRole
 * @param {Object} req - Express request (for IP, userAgent, identity)
 * @returns {Promise<void>}
 */
async function logAuditEvent(action, options = {}, req = null) {
  try {
    // Identity normally comes from CLS (set by auth middleware); login/signup
    // run before that, so those callers pass identity via options.
    const account = getAccountContext();
    const actingUserId = options.actorUserId || getUserId() || req?.userId || null;

    const event = {
      requestId: getRequestId() || req?.requestId || 'unknown',

      // A sub-user's own ID, never the owner's — that separation is the point.
      userId: actingUserId,

      accountOwnerId: options.accountOwnerId || account?.ownerId || req?.ownerId || actingUserId,
      actorRole: options.actorRole || resolveActorRole(account, req),

      action,
      resourceType: options.resourceType || null,
      resourceId: options.resourceId || null,
      status: options.status || 'success',

      ipAddress: req?.ip || req?.socket?.remoteAddress || null,
      userAgent: req?.headers?.['user-agent'] || null,

      metadata: redactMetadata(options.metadata) || null,
      errorMessage: options.errorMessage || null,
      processingTimeMs: options.processingTimeMs || null,
    };

    if (!isInitialized || !boss) {
      logger.warn({ action, event }, 'Audit queue not initialized, logging to app logs only');
      return;
    }

    const jobId = await boss.send(AUDIT_QUEUE, event, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true, // 60s, 120s, 240s
      expireInSeconds: AUDIT_JOB_TTL_SECONDS, // must be < 24h per pg-boss policy
    });

    logger.debug({ jobId, action }, 'Audit event queued');
  } catch (error) {
    // Audit logging must never break the request; fall back to app logs.
    logger.error({ err: error, action, options }, 'Failed to queue audit event');
    logger.warn({ action, ...options }, 'Audit event logged to application log only');
  }
}

export { initializeAuditQueue, shutdownAuditQueue, getBoss, logAuditEvent };
