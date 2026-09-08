import { describe, expect, it } from 'vitest';
import { isFilePathEncrypted, isValidPath } from '../../../utils/filePath.js';

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
