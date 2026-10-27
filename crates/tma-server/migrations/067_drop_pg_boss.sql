-- The Node.js server queued its background work with pg-boss, in its own
-- pgboss schema. job_queue (migration 055) replaced it and nothing reads that
-- schema any more, so drop it with everything in it. Installs that never ran
-- the Node.js server have no such schema.
DROP SCHEMA IF EXISTS pgboss CASCADE;
