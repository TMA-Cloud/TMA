#!/usr/bin/env node

/**
 * Standalone background worker
 *
 * This worker:
 * 1. Connects to pg-boss queue
 * 2. Processes batched audit writes
 * 3. Runs durable scheduled maintenance
 * 4. Executes ONLYOFFICE force-save commands
 * 5. Handles graceful shutdown on SIGTERM/SIGINT
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
import { createPool, buildPoolConfig, pgbossSchema } from './config/db.js';
import { connectRedis, disconnectRedis } from './config/redis.js';
import { AUDIT_QUEUE, AUDIT_QUEUE_OPTIONS } from './services/auditQueue.js';
import {
  MAINTENANCE_QUEUE,
  MAINTENANCE_TASKS,
  ONLYOFFICE_FORCESAVE_QUEUE,
  ORPHAN_MAINTENANCE_QUEUE,
  FILE_OPERATION_QUEUE,
  initializeBackgroundQueues,
} from './services/backgroundQueue.js';
import { cleanupExpiredTrash } from './models/file/file.cleanup.model.js';
import { deleteFiles, permanentlyDeleteFiles, restoreFiles } from './models/file/file.trash.model.js';
import { deleteOrphans, scanOrphans } from './models/file/file.orphan.model.js';
import { cleanupExpiredShareLinks } from './models/share.model.js';
import { purgeStaleHeartbeats } from './models/clientHeartbeat.model.js';
import { cleanupOldAuditLogs } from './services/cleanup.js';
import { forceSaveDocument } from './services/onlyofficeAutoSave.js';
import { EventTypes, publishFileEventsBatch } from './services/fileEvents.js';
import { cleanupExpiredStorageReservations } from './services/storageReservations.js';

const logger = createRequestLogger({ service: 'background-worker' });

// Database connection pool for writing audit logs
const pool = createPool({ max: 20 });

pool.on('error', err => {
  logger.error({ err }, 'Unexpected database pool error');
});

// pg-boss instance
let boss = null;

// Worker concurrency
const CONCURRENCY = parseInt(process.env.AUDIT_WORKER_CONCURRENCY || '5');

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

/** Insert one pg-boss delivery in a single statement, preserving one audit row per event. */
async function processAuditEvents(jobs) {
  if (jobs.length === 1) return processAuditEvent(jobs[0]);
  const startedAt = Date.now();
  try {
    for (const job of jobs) validateEvent(job.data);

    const values = [];
    const tuples = jobs.map((job, rowIndex) => {
      const event = job.data;
      values.push(
        event.requestId,
        event.userId || null,
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
        event.processingTimeMs || null
      );
      const base = rowIndex * 13;
      return `(${Array.from({ length: 13 }, (_, index) => `$${base + index + 1}`).join(',')})`;
    });

    await pool.query(
      `INSERT INTO audit_log (
         request_id, user_id, account_owner_id, actor_role, action,
         resource_type, resource_id, status, ip_address, user_agent,
         metadata, error_message, processing_time_ms
       ) VALUES ${tuples.join(',')}`,
      values
    );

    const duration = (Date.now() - startedAt) / 1000;
    for (const _job of jobs) {
      recordProcessingDuration(duration);
      incrementEventsProcessed();
    }
  } catch (error) {
    const reason = error.code ? 'database_error' : 'validation_error';
    for (const _job of jobs) incrementEventsFailed(reason);
    throw error;
  }
}

async function processMaintenanceJob(job) {
  switch (job.data?.task) {
    case MAINTENANCE_TASKS.TRASH: {
      const result = await cleanupExpiredTrash();
      if (result.hasMore) {
        await boss.send(FILE_OPERATION_QUEUE, { task: 'continue-trash-cleanup' }, { startAfter: 60 });
      }
      return result;
    }
    case MAINTENANCE_TASKS.AUDIT:
      return cleanupOldAuditLogs();
    case MAINTENANCE_TASKS.SHARES:
      return cleanupExpiredShareLinks();
    case MAINTENANCE_TASKS.HEARTBEATS:
      return purgeStaleHeartbeats(10);
    case MAINTENANCE_TASKS.RESERVATIONS:
      return cleanupExpiredStorageReservations();
    default:
      throw new Error(`Unknown maintenance task: ${job.data?.task}`);
  }
}

async function processFileOperation(job) {
  const { task, ids = [], userId } = job.data || {};
  if (task === 'continue-trash-cleanup') {
    const result = await cleanupExpiredTrash();
    if (result.hasMore) {
      await boss.send(FILE_OPERATION_QUEUE, { task }, { startAfter: 60 });
    }
    return result;
  }
  if (!userId) throw new Error('Missing file-operation userId');
  let count;
  let eventType;
  if (task === 'trash') {
    count = await deleteFiles(ids, userId);
    eventType = EventTypes.FILE_DELETED;
  } else if (task === 'restore') {
    count = await restoreFiles(ids, userId);
    eventType = EventTypes.FILE_RESTORED;
  } else if (task === 'delete-permanently') {
    count = await permanentlyDeleteFiles(ids, userId);
    eventType = EventTypes.FILE_PERMANENTLY_DELETED;
  } else if (task === 'empty-trash') {
    count = await permanentlyDeleteFiles([], userId, { allTrash: true });
    eventType = EventTypes.FILE_PERMANENTLY_DELETED;
  } else {
    throw new Error(`Unknown file operation: ${task}`);
  }
  await publishFileEventsBatch([
    {
      eventType,
      userId,
      eventData: { userId, action: task, count: count || 0 },
    },
  ]);
  return { count: count || 0 };
}

/**
 * Initialize the audit worker
 */
async function initializeWorker() {
  try {
    logger.info('Starting audit worker...');

    // Ensure schema exists before pg-boss migrations run
    const schemaPool = createPool();
    await schemaPool.query(`CREATE SCHEMA IF NOT EXISTS ${pgbossSchema}`);
    await schemaPool.end();

    // Initialize pg-boss
    boss = new PgBoss({
      ...buildPoolConfig(),
      schema: pgbossSchema,
      max: 10,
      migrate: true,
    });

    boss.on('error', error => {
      logger.error({ err: error }, 'pg-boss error');
    });

    await boss.start();
    // Queues must be created before sending/working in pg-boss v10+
    await boss.createQueue(AUDIT_QUEUE, AUDIT_QUEUE_OPTIONS);
    await initializeBackgroundQueues(boss);
    await connectRedis();
    logger.info('pg-boss started successfully');

    // Subscribe to audit events queue
    await boss.work(AUDIT_QUEUE, { batchSize: CONCURRENCY }, async jobs => {
      await processAuditEvents(jobs);
    });

    await boss.work(MAINTENANCE_QUEUE, { batchSize: 1 }, async ([job]) => {
      await processMaintenanceJob(job);
    });

    await boss.work(ORPHAN_MAINTENANCE_QUEUE, { batchSize: 1 }, async ([job]) => {
      if (job.data?.task === 'scan') return scanOrphans({ graceMinutes: job.data.graceMinutes });
      if (job.data?.task === 'delete') {
        return deleteOrphans({
          storageKeys: job.data.storageKeys,
          fileIds: job.data.fileIds,
          graceMinutes: job.data.graceMinutes,
        });
      }
      throw new Error(`Unknown orphan maintenance task: ${job.data?.task}`);
    });

    await boss.work(
      FILE_OPERATION_QUEUE,
      { batchSize: 1, localConcurrency: Math.min(2, CONCURRENCY) },
      async ([job]) => {
        await processFileOperation(job);
      }
    );

    await boss.work(
      ONLYOFFICE_FORCESAVE_QUEUE,
      { batchSize: 1, localConcurrency: Math.min(4, CONCURRENCY) },
      async ([job]) => {
        const outcome = await forceSaveDocument(job.data.documentKey);
        if (outcome.closed) {
          await boss.unschedule(ONLYOFFICE_FORCESAVE_QUEUE, job.data.documentKey);
        }
      }
    );

    logger.info({ queue: AUDIT_QUEUE, concurrency: CONCURRENCY }, 'Background worker started successfully');
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

    await disconnectRedis();

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
