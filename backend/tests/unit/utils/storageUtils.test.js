import { describe, expect, it } from 'vitest';

import { checkStorageLimitExceeded, formatFileSize } from '../../../utils/storageUtils.js';

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

describe('formatFileSize', () => {
  it('renders zero without a unit calculation', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });

  it.each([
    [512, '512.0 B'],
    [KB, '1.0 KB'],
    [1536, '1.5 KB'],
    [MB, '1.0 MB'],
    [GB, '1.0 GB'],
    [1024 * GB, '1.0 TB'],
    [1024 * 1024 * GB, '1.0 PB'],
  ])('formats %i bytes as %s', (bytes, expected) => {
    expect(formatFileSize(bytes)).toBe(expected);
  });

  it('always keeps one decimal place', () => {
    expect(formatFileSize(1.5 * MB)).toBe('1.5 MB');
    expect(formatFileSize(2 * MB)).toBe('2.0 MB');
  });

  it('rounds to the nearest tenth', () => {
    expect(formatFileSize(1_234_567)).toBe('1.2 MB');
  });

  it('steps up to the next unit exactly at the boundary', () => {
    expect(formatFileSize(KB - 1)).toBe('1023.0 B');
    expect(formatFileSize(KB)).toBe('1.0 KB');
  });
});

describe('checkStorageLimitExceeded', () => {
  it('allows anything when the account has no limit', async () => {
    const result = await checkStorageLimitExceeded({
      fileSize: 500 * GB,
      used: 900 * GB,
      userStorageLimit: null,
    });
    expect(result.exceeded).toBe(false);
    expect(result.message).toBeUndefined();
  });

  it('allows an upload that fits exactly', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 5 * MB, used: 5 * MB, userStorageLimit: 10 * MB });
    expect(result.exceeded).toBe(false);
  });

  it('rejects an upload one byte over the limit', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 5 * MB + 1, used: 5 * MB, userStorageLimit: 10 * MB });
    expect(result.exceeded).toBe(true);
  });

  it('explains used, total and remaining capacity in the message', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 2 * GB, used: 9 * GB, userStorageLimit: 10 * GB });
    expect(result.exceeded).toBe(true);
    expect(result.message).toContain('9.0 GB');
    expect(result.message).toContain('10.0 GB');
    expect(result.message).toContain('1.0 GB available');
  });

  it('reports zero available rather than a negative figure when already over quota', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 1, used: 12 * GB, userStorageLimit: 10 * GB });
    expect(result.exceeded).toBe(true);
    expect(result.message).toContain('0 B available');
    expect(result.message).not.toContain('-');
  });

  it('allows a zero-byte upload that sits exactly at the limit', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 0, used: 10 * GB, userStorageLimit: 10 * GB });
    expect(result.exceeded).toBe(false);
  });

  it('rejects any upload once usage already exceeds the limit', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 0, used: 11 * GB, userStorageLimit: 10 * GB });
    expect(result.exceeded).toBe(true);
  });

  it('treats a zero limit as "no space", not as "unlimited"', async () => {
    const result = await checkStorageLimitExceeded({ fileSize: 1, used: 0, userStorageLimit: 0 });
    expect(result.exceeded).toBe(true);
  });
});
