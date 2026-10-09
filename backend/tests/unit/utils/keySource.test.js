import crypto from 'crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatKeyring,
  generateKey,
  isRandomKey,
  parseKeyring,
  primaryVersionOf,
} from '../../../utils/fileEncryption/keySource.js';
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

describe('parseKeyring', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);

  it('reads a plain key as version 1', () => {
    expect(parseKeyring(`${a}\n`)).toEqual(new Map([[1, a]]));
  });

  it('reads versioned lines with comments and blank lines', () => {
    const keys = parseKeyring(`# header\n\n1:${a}\r\n# note\n2:${b}\n`);
    expect([...keys]).toEqual([
      [1, a],
      [2, b],
    ]);
    expect(primaryVersionOf(keys)).toBe(2);
  });

  it('reads comma-separated entries, the form that fits on one .env line', () => {
    expect([...parseKeyring(`3:${a}, 5:${b}`)]).toEqual([
      [3, a],
      [5, b],
    ]);
  });

  it('keeps base64 padding in the key', () => {
    const key = crypto.randomBytes(32).toString('base64');
    expect(parseKeyring(`4:${key}`).get(4)).toBe(key);
  });

  it.each([
    ['an empty value', '# only a comment\n'],
    ['several keys without versions', `${a}\n${b}`],
    ['a mix of plain and versioned keys', `${a}\n2:${b}`],
    ['version 0', `0:${a}`],
    ['a repeated version', `1:${a}\n1:${b}`],
  ])('rejects %s', (_label, text) => {
    expect(() => parseKeyring(text)).toThrow(/FILE_ENCRYPTION_KEY/);
  });

  it('round-trips through formatKeyring, oldest version first', () => {
    const keys = new Map([
      [2, b],
      [1, a],
    ]);
    const text = formatKeyring(keys);
    expect(text.startsWith('#')).toBe(true);
    expect(text.trim().split('\n').slice(-2)).toEqual([`1:${a}`, `2:${b}`]);
    expect(parseKeyring(text)).toEqual(keys);
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
