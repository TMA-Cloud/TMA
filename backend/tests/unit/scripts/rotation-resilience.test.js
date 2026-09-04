import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_RETRIES,
  isTransientError,
  nextBackoffMs,
  withRetries,
} from '../../../scripts/lib/rotation-resilience.js';

// No real waiting: withRetries takes an injectable `wait`.
const noWait = () => Promise.resolve();

describe('isTransientError', () => {
  it('treats socket-level network errors as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND']) {
      expect(isTransientError({ code })).toBe(true);
    }
  });

  it('treats 429 and 5xx HTTP statuses as transient', () => {
    expect(isTransientError({ $metadata: { httpStatusCode: 429 } })).toBe(true);
    expect(isTransientError({ $metadata: { httpStatusCode: 500 } })).toBe(true);
    expect(isTransientError({ $metadata: { httpStatusCode: 503 } })).toBe(true);
  });

  it('matches S3 throttling and timeout messages', () => {
    expect(isTransientError(new Error('Please reduce your request rate: SlowDown'))).toBe(true);
    expect(isTransientError(new Error('The request was throttled'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('does not retry a deterministic auth/format failure', () => {
    // A wrong key surfaces as a GCM auth error — retrying it is pointless.
    expect(isTransientError(new Error('Unsupported state or unable to authenticate data'))).toBe(false);
    expect(isTransientError({ $metadata: { httpStatusCode: 404 } })).toBe(false);
    expect(isTransientError(new Error('Invalid encrypted stream: header too short'))).toBe(false);
  });

  it('tolerates null/undefined without throwing', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});

describe('nextBackoffMs', () => {
  it('grows exponentially and is capped', () => {
    expect(nextBackoffMs(1, { jitter: 0 })).toBe(500);
    expect(nextBackoffMs(2, { jitter: 0 })).toBe(1000);
    expect(nextBackoffMs(3, { jitter: 0 })).toBe(2000);
    expect(nextBackoffMs(20, { jitter: 0 })).toBe(30000); // capped
  });

  it('adds bounded jitter on top of the exponential base', () => {
    for (let i = 0; i < 50; i++) {
      const ms = nextBackoffMs(1, { jitter: 250 });
      expect(ms).toBeGreaterThanOrEqual(500);
      expect(ms).toBeLessThan(750);
    }
  });
});

describe('withRetries', () => {
  it('returns the value when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetries(fn, { wait: noWait })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and eventually succeeds', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 503 } })
      .mockRejectedValueOnce({ code: 'ECONNRESET' })
      .mockResolvedValue('done');
    const onRetry = vi.fn();
    await expect(withRetries(fn, { wait: noWait, onRetry })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toMatchObject({ attempt: 1, retries: DEFAULT_RETRIES });
  });

  it('throws a non-transient error immediately without retrying', async () => {
    const err = new Error('bad key: unable to authenticate data');
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetries(fn, { wait: noWait })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    const err = { code: 'ETIMEDOUT' };
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withRetries(fn, { retries: 3, wait: noWait })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(4); // first attempt + 3 retries
  });

  it('honours a custom isTransient predicate', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('nope')).mockResolvedValue('ok');
    await expect(withRetries(fn, { wait: noWait, isTransient: () => true })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
