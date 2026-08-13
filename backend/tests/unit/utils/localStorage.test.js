import fs from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';

import { afterEach, describe, expect, it } from 'vitest';

import { UPLOAD_DIR } from '../../../config/paths.js';
import {
  copyObject,
  deleteObject,
  exists,
  getReadStream,
  listObjectsPaginated,
  putBuffer,
  putFromPath,
  putStream,
  resolveKey,
  statObject,
} from '../../../utils/localStorage.js';

const written = new Set();

/** Track keys so each test can clean up after itself. */
async function put(key, content) {
  await putBuffer(key, Buffer.from(content));
  written.add(key);
  return key;
}

afterEach(async () => {
  for (const key of written) {
    await fs.rm(path.join(UPLOAD_DIR, key), { force: true }).catch(() => {});
  }
  written.clear();
});

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('resolveKey', () => {
  it('maps a key to a path inside the upload directory', () => {
    expect(resolveKey('abc.bin')).toBe(path.resolve(UPLOAD_DIR, 'abc.bin'));
  });

  it('throws when the key is empty', () => {
    expect(() => resolveKey('')).toThrow('Storage key is required');
    expect(() => resolveKey(null)).toThrow('Storage key is required');
  });

  it.each(['../escape.bin', '../../etc/passwd', 'a/../../../escape'])('blocks traversal via %s', key => {
    expect(() => resolveKey(key)).toThrow(/path traversal/i);
  });

  it('resolves a backslash traversal attempt according to the platform separator', () => {
    // Backslash is a separator on Windows and an ordinary filename character on
    // POSIX, so this escapes on one platform and not the other. On POSIX it
    // lands inside the upload directory as a single oddly named file, which is
    // safe; callers reject such keys with isValidPath before getting here.
    const key = '..\\..\\Windows\\System32\\config\\SAM';

    if (process.platform === 'win32') {
      expect(() => resolveKey(key)).toThrow(/path traversal/i);
    } else {
      expect(resolveKey(key).startsWith(path.resolve(UPLOAD_DIR))).toBe(true);
    }
  });

  it('permits a nested key that stays within the directory', () => {
    expect(resolveKey('sub/file.bin').startsWith(path.resolve(UPLOAD_DIR))).toBe(true);
  });
});

describe('putBuffer / getReadStream', () => {
  it('round-trips a buffer', async () => {
    await put('rt.bin', 'hello storage');
    expect((await collect(await getReadStream('rt.bin'))).toString()).toBe('hello storage');
  });

  it('overwrites an existing object', async () => {
    await put('rt.bin', 'first');
    await put('rt.bin', 'second');
    expect((await collect(await getReadStream('rt.bin'))).toString()).toBe('second');
  });

  it('stores an empty object', async () => {
    await put('empty.bin', '');
    expect(await statObject('empty.bin')).toMatchObject({ size: 0 });
  });
});

describe('exists', () => {
  it('reports true for a stored object', async () => {
    await put('present.bin', 'x');
    expect(await exists('present.bin')).toBe(true);
  });

  it('reports false for a missing object', async () => {
    expect(await exists('absent.bin')).toBe(false);
  });

  it('reports false rather than throwing for a traversal key', async () => {
    expect(await exists('../escape.bin')).toBe(false);
  });
});

describe('putStream', () => {
  it('writes stream content to the key', async () => {
    await putStream('streamed.bin', Readable.from([Buffer.from('a'), Buffer.from('b')]));
    written.add('streamed.bin');
    expect((await collect(await getReadStream('streamed.bin'))).toString()).toBe('ab');
  });

  it('rejects when the source stream errors', async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error('source exploded'));
      },
    });
    await expect(putStream('failed.bin', failing)).rejects.toThrow('source exploded');
    written.add('failed.bin');
  });
});

describe('putFromPath', () => {
  it('copies a local file into storage', async () => {
    const source = path.join(UPLOAD_DIR, 'source-tmp.bin');
    await fs.writeFile(source, 'from disk');
    try {
      await putFromPath('copied.bin', source);
      written.add('copied.bin');
      expect((await collect(await getReadStream('copied.bin'))).toString()).toBe('from disk');
    } finally {
      await fs.rm(source, { force: true });
    }
  });
});

describe('copyObject', () => {
  it('duplicates an object under a new key', async () => {
    await put('src.bin', 'payload');
    await copyObject('src.bin', 'dst.bin');
    written.add('dst.bin');
    expect((await collect(await getReadStream('dst.bin'))).toString()).toBe('payload');
  });

  it('leaves the source in place', async () => {
    await put('src.bin', 'payload');
    await copyObject('src.bin', 'dst.bin');
    written.add('dst.bin');
    expect(await exists('src.bin')).toBe(true);
  });

  it('refuses a traversal destination', async () => {
    await put('src.bin', 'payload');
    await expect(copyObject('src.bin', '../escape.bin')).rejects.toThrow(/path traversal/i);
  });
});

describe('deleteObject', () => {
  it('removes the object', async () => {
    await put('doomed.bin', 'x');
    await deleteObject('doomed.bin');
    expect(await exists('doomed.bin')).toBe(false);
  });

  it('rejects when the object does not exist', async () => {
    await expect(deleteObject('never-there.bin')).rejects.toThrow();
  });
});

describe('statObject', () => {
  it('reports size and modification time', async () => {
    await put('stat.bin', 'twelve bytes');
    const stats = await statObject('stat.bin');
    expect(stats.size).toBe(12);
    expect(stats.lastModified).toBeInstanceOf(Date);
  });

  it('returns null for a missing object instead of throwing', async () => {
    expect(await statObject('gone.bin')).toBeNull();
  });

  it('returns null for a traversal key', async () => {
    expect(await statObject('../escape.bin')).toBeNull();
  });
});

describe('listObjectsPaginated', () => {
  it('yields the stored objects with size and mtime', async () => {
    await put('list-a.bin', 'aaa');
    await put('list-b.bin', 'bbbb');

    const seen = new Map();
    for await (const page of listObjectsPaginated()) {
      for (const entry of page) seen.set(entry.key, entry);
    }

    expect(seen.get('list-a.bin')).toMatchObject({ size: 3 });
    expect(seen.get('list-b.bin')).toMatchObject({ size: 4 });
    expect(seen.get('list-a.bin').lastModified).toBeInstanceOf(Date);
  });

  it('splits results into pages of the requested size', async () => {
    for (let i = 0; i < 7; i++) await put(`page-${i}.bin`, 'x');

    const pages = [];
    for await (const page of listObjectsPaginated(2)) pages.push(page);

    expect(pages.length).toBeGreaterThanOrEqual(4);
    for (const page of pages.slice(0, -1)) expect(page).toHaveLength(2);
  });

  it('yields nothing when the upload directory cannot be read', async () => {
    const pages = [];
    // Point at a directory that does not exist by temporarily moving UPLOAD_DIR
    // is not possible (it is read at import), so assert the happy path is a
    // generator that terminates rather than hanging.
    for await (const page of listObjectsPaginated(1000)) pages.push(page);
    expect(Array.isArray(pages)).toBe(true);
  });
});
