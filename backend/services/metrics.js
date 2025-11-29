const promClient = require('prom-client');
const { logger } = require('../config/logger');
const { getBoss } = require('./auditLogger');

// Create a registry for metrics
const register = new promClient.Registry();

// Add default metrics (memory, CPU, event loop, etc.)
promClient.collectDefaultMetrics({
  register,
  prefix: 'nodejs_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// ============================================================================
// Audit-specific metrics
// ============================================================================

/**
 * Counter: Total number of audit events queued
 * Labels: action, status
 */
const auditEventsQueuedTotal = new promClient.Counter({
  name: 'audit_events_queued_total',
  help: 'Total number of audit events queued to pg-boss',
  labelNames: ['action', 'status'],
  registers: [register],
});

/**
 * Counter: Total number of audit events successfully processed
 */
const auditEventsProcessedTotal = new promClient.Counter({
  name: 'audit_events_processed_total',
  help: 'Total number of audit events successfully written to database',
  registers: [register],
});

/**
 * Counter: Total number of audit events that failed processing
 * Labels: reason
 */
const auditEventsFailedTotal = new promClient.Counter({
  name: 'audit_events_failed_total',
  help: 'Total number of audit events that failed to process',
  labelNames: ['reason'],
  registers: [register],
});

/**
 * Gauge: Current depth of the audit events queue
 */
const auditQueueDepth = new promClient.Gauge({
  name: 'audit_queue_depth',
  help: 'Current number of audit events waiting in the queue',
  registers: [register],
});

/**
 * Gauge: Current depth of failed audit events
 */
const auditQueueFailedDepth = new promClient.Gauge({
  name: 'audit_queue_failed_depth',
  help: 'Current number of failed audit events in the queue',
  registers: [register],
});

/**
 * Histogram: Time taken to process audit events
 */
const auditProcessingDuration = new promClient.Histogram({
  name: 'audit_processing_duration_seconds',
  help: 'Time taken to process and write audit events to database',
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

/**
 * Gauge: Timestamp of the last successfully processed audit event
 */
const auditLastProcessedTimestamp = new promClient.Gauge({
  name: 'audit_last_processed_timestamp',
  help: 'Unix timestamp of the last successfully processed audit event',
  registers: [register],
});

// ============================================================================
// Metric update functions
// ============================================================================

/**
 * Increment the counter when an audit event is queued
 * @param {string} action - The audit action (e.g., 'file.upload')
 * @param {string} status - The event status ('success', 'failure', 'error')
 */
function incrementEventsQueued(action, status = 'success') {
  try {
    auditEventsQueuedTotal.labels(action, status).inc();
  } catch (error) {
    logger.error({ err: error }, 'Failed to increment audit_events_queued_total metric');
  }
}

/**
 * Increment the counter when an audit event is successfully processed
 */
function incrementEventsProcessed() {
  try {
    auditEventsProcessedTotal.inc();
    auditLastProcessedTimestamp.setToCurrentTime();
  } catch (error) {
    logger.error({ err: error }, 'Failed to increment audit_events_processed_total metric');
  }
}

/**
 * Increment the counter when an audit event fails to process
 * @param {string} reason - The failure reason (e.g., 'database_error', 'validation_error')
 */
function incrementEventsFailed(reason = 'unknown') {
  try {
    auditEventsFailedTotal.labels(reason).inc();
  } catch (error) {
    logger.error({ err: error }, 'Failed to increment audit_events_failed_total metric');
  }
}

/**
 * Record the duration of audit event processing
 * @param {number} durationSeconds - Duration in seconds
 */
function recordProcessingDuration(durationSeconds) {
  try {
    auditProcessingDuration.observe(durationSeconds);
  } catch (error) {
    logger.error({ err: error }, 'Failed to record audit_processing_duration metric');
  }
}

/**
 * Update queue depth metrics from pg-boss
 *
 * This should be called periodically (e.g., every 30 seconds) to update
 * the queue depth gauges.
 */
async function updateQueueMetrics() {
  try {
    const boss = getBoss();
    if (!boss) {
      return;
    }

    // Get queue statistics from pg-boss
    const queueSize = await boss.getQueueSize('audit-events');

    auditQueueDepth.set(queueSize);

    // Get failed job count
    const failedCount = await boss.getQueueSize('audit-events', { state: 'failed' });
    auditQueueFailedDepth.set(failedCount);

    logger.debug({ queueSize, failedCount }, 'Updated queue metrics');
  } catch (error) {
    logger.error({ err: error }, 'Failed to update queue metrics');
  }
}

/**
 * Start periodic queue metrics updates
 * @param {number} intervalSeconds - Update interval in seconds (default: 30)
 * @returns {NodeJS.Timeout} The interval timer
 */
function startQueueMetricsUpdater(intervalSeconds = 30) {
  logger.info({ intervalSeconds }, 'Starting queue metrics updater');
  return setInterval(updateQueueMetrics, intervalSeconds * 1000);
}

/**
 * Initialize metrics collection
 */
function initializeMetrics() {
  logger.info('Metrics initialized successfully');
}

/**
 * Express middleware to expose metrics at /metrics endpoint
 */
async function metricsEndpoint(req, res) {
  try {
    // Update queue metrics before serving (for real-time accuracy)
    await updateQueueMetrics();

    res.setHeader('Content-Type', register.contentType);
    res.send(await register.metrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate metrics');
    res.status(500).send('Failed to generate metrics');
  }
}

module.exports = {
  register,
  initializeMetrics,
  metricsEndpoint,
  startQueueMetricsUpdater,

  // Metric update functions
  incrementEventsQueued,
  incrementEventsProcessed,
  incrementEventsFailed,
  recordProcessingDuration,
  updateQueueMetrics,
};
