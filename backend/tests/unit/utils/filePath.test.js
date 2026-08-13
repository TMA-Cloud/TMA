import path from 'path';

import { describe, expect, it } from 'vitest';

import { UPLOAD_DIR } from '../../../config/paths.js';
import { isFilePathEncrypted, isValidPath, resolveFilePath, resolveFilePathIfLocal } from '../../../utils/filePath.js';

describe('resolveFilePath', () => {
  it('resolves a stored key to an absolute path inside the upload directory', () => {
    const resolved = resolveFilePath('abc123.pdf');
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.resolve(UPLOAD_DIR, 'abc123.pdf'));
  });

  it('throws when no path is given', () => {
    expect(() => resolveFilePath('')).toThrow('File path is required');
    expect(() => resolveFilePath(null)).toThrow('File path is required');
    expect(() => resolveFilePath(undefined)).toThrow('File path is required');
  });

  it.each([
    '../../../etc/passwd',
    '..\\..\\..\\Windows\\System32\\config\\SAM',
    '../outside.txt',
    'sub/../../escape.txt',
  ])('refuses to escape the upload directory via %s', key => {
    expect(() => resolveFilePath(key)).toThrow(/path traversal/i);
  });

  it('allows a nested key that stays inside the upload directory', () => {
    const resolved = resolveFilePath('nested/file.bin');
    expect(resolved.startsWith(path.resolve(UPLOAD_DIR))).toBe(true);
  });
});

describe('resolveFilePathIfLocal', () => {
  it('resolves for the local driver', () => {
    expect(resolveFilePathIfLocal('abc123.pdf')).toBe(path.resolve(UPLOAD_DIR, 'abc123.pdf'));
  });

  it('returns null for an empty path instead of throwing', () => {
    expect(resolveFilePathIfLocal('')).toBeNull();
    expect(resolveFilePathIfLocal(null)).toBeNull();
  });

  it('still refuses traversal', () => {
    expect(() => resolveFilePathIfLocal('../escape.txt')).toThrow(/path traversal/i);
  });
});

describe('isValidPath', () => {
  it('accepts a flat storage key', () => {
    expect(isValidPath('abc123.pdf')).toBe(true);
    expect(isValidPath('file-1700000000000-123456789.docx')).toBe(true);
  });

  it('rejects empty values', () => {
    expect(isValidPath('')).toBe(false);
    expect(isValidPath(null)).toBe(false);
    expect(isValidPath(undefined)).toBe(false);
  });

  it('rejects any separator, because stored keys are always flat', () => {
    expect(isValidPath('sub/file.pdf')).toBe(false);
    expect(isValidPath('sub\\file.pdf')).toBe(false);
  });

  it('rejects traversal sequences', () => {
    expect(isValidPath('..')).toBe(false);
    expect(isValidPath('../file.pdf')).toBe(false);
    expect(isValidPath('a..b')).toBe(false);
  });
});

describe('isFilePathEncrypted', () => {
  it('reports true for any stored file, since everything at rest is encrypted', () => {
    expect(isFilePathEncrypted('abc123.pdf')).toBe(true);
    expect(isFilePathEncrypted('anything')).toBe(true);
  });

  it('reports false when there is no path at all', () => {
    expect(isFilePathEncrypted('')).toBe(false);
    expect(isFilePathEncrypted(null)).toBe(false);
    expect(isFilePathEncrypted(undefined)).toBe(false);
  });
});
