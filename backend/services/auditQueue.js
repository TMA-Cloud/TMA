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
  // Seconds, not days: pg-boss v10+ dropped `retentionDays`, and an unknown
  // key is ignored rather than rejected, so the old spelling silently left the
  // queue on the 14-day default.
  retentionSeconds: 30 * 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
};

export { AUDIT_QUEUE, AUDIT_QUEUE_OPTIONS };
