/**
 * Stand-in for config/db.js.
 *
 * The real module builds a pg Pool and immediately dials the database, so every
 * test that imports a model would otherwise need Postgres running. This exposes
 * the same shape backed by a vi.fn, plus a small queue helper so a test can say
 * "the next query returns these rows" without hand-rolling a mock each time.
 */

import { vi } from 'vitest';

/** Queued responses, consumed one per query() call. */
let queue = [];
/** Every [sql, params] pair the code under test ran, in order. */
const calls = [];

const DEFAULT_RESULT = { rows: [], rowCount: 0 };

function nextResult(sql, params) {
  calls.push({ sql, params });
  if (queue.length === 0) return DEFAULT_RESULT;
  const next = queue.shift();
  if (typeof next === 'function') return next(sql, params);
  if (next instanceof Error) throw next;
  return next;
}

const query = vi.fn(async (sql, params) => nextResult(sql, params));

const release = vi.fn();
const clientQuery = vi.fn(async (sql, params) => nextResult(sql, params));
const connect = vi.fn(async () => ({ query: clientQuery, release }));

const pool = {
  query,
  connect,
  end: vi.fn(async () => {}),
  on: vi.fn(),
};

function buildPoolConfig(overrides = {}) {
  return { host: 'localhost', port: 5432, user: 'test', database: 'test', ...overrides };
}

function createPool(overrides = {}) {
  void overrides;
  return pool;
}

/* ------------------------------------------------------------------ *
 * Test-facing controls
 * ------------------------------------------------------------------ */

/**
 * Queue results for upcoming query() calls, in order.
 * Each entry may be a result object, an Error (thrown), or a
 * (sql, params) => result function for conditional responses.
 */
function queueQueryResults(...results) {
  queue.push(...results.flat());
}

/** Answer every query with the same result until reset. */
function alwaysReturn(result) {
  query.mockImplementation(async (sql, params) => {
    calls.push({ sql, params });
    return typeof result === 'function' ? result(sql, params) : result;
  });
  clientQuery.mockImplementation(query.getMockImplementation());
}

/** All SQL statements executed so far. */
function executedSql() {
  return calls.map(c => c.sql);
}

/** Every recorded call, with params. */
function executedCalls() {
  return [...calls];
}

/** Wipe the queue, the call log, and any alwaysReturn override. */
function resetDbMock() {
  queue = [];
  calls.length = 0;
  query.mockReset();
  clientQuery.mockReset();
  connect.mockReset();
  release.mockReset();
  query.mockImplementation(async (sql, params) => nextResult(sql, params));
  clientQuery.mockImplementation(async (sql, params) => nextResult(sql, params));
  connect.mockImplementation(async () => ({ query: clientQuery, release }));
}

export { createPool, buildPoolConfig };
export { queueQueryResults, alwaysReturn, executedSql, executedCalls, resetDbMock, query, connect, clientQuery };
export default pool;
