import crypto from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuredKeyVersions, generateKey, isRandomKey } from '../../../utils/fileEncryption/keySource.js';
import { kekCheckValue, matchesKekCheck } from '../../../utils/fileEncryption/keyCheck.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isRandomKey', () => {
  it.each([
    ['64 hex characters', 'ab'.repeat(32)],
    ['standard base64 of 32 bytes', crypto.randomBytes(32).toString('base64')],
    ['url-safe base64 of 32 bytes', crypto.randomBytes(32).toString('base64url')],
  ])('accepts %s', (_label, key) => {
    expect(isRandomKey(key)).toBe(true);
  });

  it.each([
    ['the example passphrase', 'tma_cloud_file_encryption_key'],
    ['base64 of 16 bytes', crypto.randomBytes(16).toString('base64')],
    ['63 hex characters', 'a'.repeat(63)],
    ['a 43-character passphrase with spaces', 'correct horse battery staple and more words'],
  ])('rejects %s', (_label, key) => {
    expect(isRandomKey(key)).toBe(false);
  });

  it('generates keys it accepts, never the same twice', () => {
    const a = generateKey();
    expect(isRandomKey(a)).toBe(true);
    expect(generateKey()).not.toBe(a);
  });
});

describe('configuredKeyVersions', () => {
  it('lists the primary plus every older key present in the environment', () => {
    vi.stubEnv('FILE_ENCRYPTION_KEY_V1', 'old');
    vi.stubEnv('FILE_ENCRYPTION_KEY_V3_FILE', '/run/secrets/v3');
    vi.stubEnv('FILE_ENCRYPTION_KEY_V4', '');
    expect(configuredKeyVersions(5)).toEqual([1, 3, 5]);
  });
});

describe('key check values', () => {
  const kek = crypto.randomBytes(32);

  it('matches the same key and nothing else', () => {
    const check = kekCheckValue(kek);
    expect(matchesKekCheck(kek, check)).toBe(true);
    expect(matchesKekCheck(crypto.randomBytes(32), check)).toBe(false);
    expect(matchesKekCheck(kek, check.subarray(0, 16))).toBe(false);
  });

  it('does not contain the key', () => {
    expect(kekCheckValue(kek).includes(kek)).toBe(false);
    expect(kekCheckValue(kek).equals(kek)).toBe(false);
  });
});
