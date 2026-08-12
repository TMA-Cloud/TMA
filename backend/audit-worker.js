#!/usr/bin/env node

/**
 * Audit Worker - Standalone process for processing audit events
 *
 * This worker:
 * 1. Connects to pg-boss queue
 * 2. Subscribes to 'audit-events' queue
 * 3. Processes events concurrently (default: 5)
 * 4. Writes audit events to audit_log table
 * 5. Updates Prometheus metrics
 * 6. Handles graceful shutdown on SIGTERM/SIGINT
 *
 * Usage:
 *   node backend/audit-worker.js
 *
 * Environment Variables:
 *   AUDIT_WORKER_CONCURRENCY - Number of concurrent jobs to process (default: 5)
 *   LOG_LEVEL - Logging level (default: info)
 */
import './config/env.js';

import { PgBoss } from 'pg-boss';

import { incrementEventsProcessed, incrementEventsFailed, recordProcessingDuration } from './services/metrics.js';
import { createRequestLogger } from './config/logger.js';
import { createPool, buildPoolConfig } from './config/db.js';

const logger = createRequestLogger({ service: 'audit-worker' });

// Database connection pool for writing audit logs
const pool = createPool({ max: 20 });

pool.on('error', err => {
  logger.error({ err }, 'Unexpected database pool error');
});

// pg-boss instance
let boss = null;

// Worker concurrency
const CONCURRENCY = parseInt(process.env.AUDIT_WORKER_CONCURRENCY || '5');
const AUDIT_QUEUE = 'audit-events';

/**
 * Validate audit event schema
 *
 * @param {Object} event - The audit event to validate
 * @returns {boolean} True if valid
 * @throws {Error} If validation fails
 */
function validateEvent(event) {
  if (!event.requestId) {
    throw new Error('Missing required field: requestId');
  }
  if (!event.action) {
    throw new Error('Missing required field: action');
  }
  if (event.status && !['success', 'failure', 'error'].includes(event.status)) {
    throw new Error(`Invalid status: ${event.status}`);
  }
  return true;
}

/**
 * Process a single audit event
 *
 * Writes the event to the audit_log table and updates metrics.
 *
 * @param {Object} job - The pg-boss job object
 * @returns {Promise<void>}
 */
async function processAuditEvent(job) {
  const startTime = Date.now();
  const event = job.data;

  try {
    // Log only safe fields to prevent accidental exposure of sensitive data
    logger.debug(
      {
        jobId: job.id,
        action: event.action,
        status: event.status,
        resourceType: event.resourceType,
      },
      'Processing audit event'
    );

    // Validate event schema
    validateEvent(event);

    // Insert into audit_log table
    const query = `
      INSERT INTO audit_log (
        request_id,
        user_id,
        account_owner_id,
        actor_role,
        action,
        resource_type,
        resource_id,
        status,
        ip_address,
        user_agent,
        metadata,
        error_message,
        processing_time_ms
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id
    `;

    const values = [
      event.requestId,
      event.userId || null,
      // Which account the action happened under. Equals user_id for a
      // top-level account; the parent for a sub-user.
      event.accountOwnerId || event.userId || null,
      event.actorRole || null,
      event.action,
      event.resourceType || null,
      event.resourceId || null,
      event.status || 'success',
      event.ipAddress || null,
      event.userAgent || null,
      event.metadata ? JSON.stringify(event.metadata) : null,
      event.errorMessage || null,
      event.processingTimeMs || null,
    ];

    await pool.query(query, values);

    // Record metrics
    const duration = (Date.now() - startTime) / 1000; // Convert to seconds
    recordProcessingDuration(duration);
    incrementEventsProcessed();
  } catch (error) {
    // Determine failure reason
    let reason = 'unknown';
    if (error.message.includes('Missing required field')) {
      reason = 'validation_error';
    } else if (error.code && error.code.startsWith('23')) {
      // PostgreSQL integrity constraint violations
      reason = 'database_constraint_error';
    } else if (error.code) {
      reason = 'database_error';
    }

    incrementEventsFailed(reason);

    // Log only safe fields to prevent accidental exposure of sensitive data
    logger.error(
      {
        err: error,
        jobId: job.id,
        action: event.action,
        status: event.status,
        resourceType: event.resourceType,
        reason,
      },
      'Failed to process audit event'
    );

    // Re-throw to let pg-boss handle retries
    throw error;
  }
}

/**
 * Initialize the audit worker
 */
async function initializeWorker() {
  try {
    logger.info('Starting audit worker...');

    // Ensure schema exists before pg-boss migrations run
    const schema = process.env.PGBOSS_SCHEMA || 'pgboss';
    const schemaPool = createPool();
    await schemaPool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await schemaPool.end();

    // Initialize pg-boss
    boss = new PgBoss({
      ...buildPoolConfig(),
      schema,
      max: 10,
      migrate: true,
    });

    boss.on('error', error => {
      logger.error({ err: error }, 'pg-boss error');
    });

    await boss.start();
    // Queues must be created before sending/working in pg-boss v10+
    await boss.createQueue(AUDIT_QUEUE, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      retentionDays: 30,
    });
    logger.info('pg-boss started successfully');

    // Subscribe to audit events queue
    await boss.work(AUDIT_QUEUE, { batchSize: CONCURRENCY }, async jobs => {
      // Handler now receives an array in pg-boss v10+
      for (const job of jobs) {
        await processAuditEvent(job);
      }
    });

    logger.info({ queue: AUDIT_QUEUE, concurrency: CONCURRENCY }, 'Audit worker started successfully');
  } catch (error) {
    logger.error({ err: error }, 'Failed to initialize audit worker');
    process.exit(1);
  }
}

/**
 * Graceful shutdown
 */
async function shutdown() {
  logger.info('Shutting down audit worker...');

  try {
    // Stop accepting new jobs
    if (boss) {
      await boss.stop();
      logger.info('pg-boss stopped');
    }

    // Close database pool
    await pool.end();
    logger.info('Database pool closed');

    logger.info('Audit worker shut down successfully');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

// Handle graceful shutdown signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Handle uncaught errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled Promise Rejection');
});

process.on('uncaughtException', error => {
  logger.error({ err: error }, 'Uncaught Exception');
  process.exit(1);
});

// Start the worker
initializeWorker().catch(error => {
  logger.error({ err: error }, 'Fatal error during worker initialization');
  process.exit(1);
});
