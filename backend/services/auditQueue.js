/**
 * Queue identity and retention shared by the audit producer (auditLogger) and
 * the audit consumer (audit-worker).
 *
 * Both processes call boss.createQueue() with these settings; whichever starts
 * first creates the queue, so the two must agree exactly. Defining them once
 * here removes the chance of the producer and the worker disagreeing about
 * which queue they are talking to or how long its jobs are kept.
 */

const AUDIT_QUEUE = 'audit-events';

const AUDIT_QUEUE_OPTIONS = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
  retentionDays: 30,
};

export { AUDIT_QUEUE, AUDIT_QUEUE_OPTIONS };
