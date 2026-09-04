/**
 * Shared resilience helpers for the long-running, at-scale storage scripts
 * (key rotation, streaming-format migration): classify transient storage errors
 * and retry an operation with exponential backoff + jitter.
 *
 * Pure and side-effect free — no db/logger/storage imports — so it can be
 * unit-tested directly and reused by any script without opening a DB pool.
 */

const DEFAULT_RETRIES = 5;
const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 30000;
const DEFAULT_JITTER_MS = 250;

/** Transient network/S3 hiccups worth retrying rather than failing the object. */
function isTransientError(err) {
  const code = err?.code || err?.Code || err?.name || '';
  const msg = (err?.message || '').toLowerCase();
  const status = err?.$metadata?.httpStatusCode;
  if (['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  return (
    msg.includes('aborted') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('throttl') ||
    msg.includes('slowdown')
  );
}

/** Backoff delay (with optional jitter) for a 1-based attempt number, capped. */
function nextBackoffMs(attempt, { base = DEFAULT_BASE_MS, cap = DEFAULT_CAP_MS, jitter = DEFAULT_JITTER_MS } = {}) {
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return exp + (jitter > 0 ? Math.floor(Math.random() * jitter) : 0);
}

const sleep = ms =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Run `fn`, retrying transient failures with exponential backoff. Non-transient
 * errors (a bad key, a missing object) throw immediately so callers can act on
 * them rather than waiting out pointless retries.
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {number} [opts.retries]                          Max retries after the first attempt.
 * @param {(err: unknown) => boolean} [opts.isTransient]   Override the transient test.
 * @param {(err: unknown, info: { attempt: number, retries: number, backoff: number }) => void} [opts.onRetry]
 *   Invoked before each backoff wait (for logging).
 * @param {(ms: number) => Promise<void>} [opts.wait]      Override the sleeper (tests).
 * @returns {Promise<T>}
 * @template T
 */
async function withRetries(
  fn,
  { retries = DEFAULT_RETRIES, isTransient = isTransientError, onRetry, wait = sleep } = {}
) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (attempt > retries || !isTransient(err)) throw err;
      const backoff = nextBackoffMs(attempt);
      if (onRetry) onRetry(err, { attempt, retries, backoff });
      await wait(backoff);
    }
  }
}

export { isTransientError, nextBackoffMs, withRetries, DEFAULT_RETRIES };
