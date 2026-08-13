import path from 'path';

import { describe, expect, it } from 'vitest';

import { UPLOAD_DIR } from '../../../config/paths.js';
import storage, {
  getDriver,
  listKeys,
  listKeysPaginated,
  resolveKeyToPath,
  useS3,
} from '../../../utils/storageDriver.js';
import * as localStorage from '../../../utils/localStorage.js';

// The suite runs with STORAGE_DRIVER=local, so the facade should delegate to
// the local driver throughout.

describe('driver selection', () => {
  it('reports the local driver when S3 is not configured', () => {
    expect(useS3()).toBe(false);
  });

  it('delegates to the local storage module', () => {
    expect(getDriver()).toBe(localStorage);
  });

  it('exposes the same surface as a named import and as the default export', () => {
    expect(storage.useS3).toBe(useS3);
    expect(storage.getDriver).toBe(getDriver);
  });
});

describe('resolveKeyToPath', () => {
  it('resolves a key to an absolute path under the local driver', () => {
    expect(resolveKeyToPath('abc.bin')).toBe(path.resolve(UPLOAD_DIR, 'abc.bin'));
  });

  it('still refuses traversal', () => {
    expect(() => resolveKeyToPath('../escape.bin')).toThrow(/path traversal/i);
  });
});

describe('S3-only helpers under the local driver', () => {
  it('listKeys degrades to an empty list rather than throwing', async () => {
    expect(await listKeys()).toEqual([]);
  });

  it('listKeysPaginated degrades to an empty async generator', async () => {
    const pages = [];
    for await (const page of listKeysPaginated()) pages.push(page);
    expect(pages).toEqual([]);
  });
});

describe('facade surface', () => {
  it.each([
    'exists',
    'getReadStream',
    'putFromPath',
    'putBuffer',
    'putStream',
    'deleteObject',
    'copyObject',
    'listKeys',
    'listKeysPaginated',
    'listObjectsPaginated',
    'statObject',
    'resolveKeyToPath',
    'useS3',
    'getDriver',
  ])('exposes %s', name => {
    expect(typeof storage[name]).toBe('function');
  });
});
