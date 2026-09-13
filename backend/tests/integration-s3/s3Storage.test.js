/**
 * The S3-compatible storage driver, against the real object store.
 *
 * Every key this writes is namespaced under a unique per-run prefix and removed
 * afterwards, so the suite cannot collide with anything else in the bucket.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { s3 } from '../../config/storage.js';
import {
  copyObject,
  deleteObject,
  deleteObjects,
  exists,
  getReadStream,
  listObjectsPaginated,
  multipartCopyObject,
  putBuffer,
  putFromPath,
  putStream,
  statObject,
} from '../../utils/s3Storage.js';
import { createDecryptStreamFromStream, createEncryptStream } from '../../utils/fileEncryption.js';
import { DEFAULT_UPLOAD_PART_SIZE } from '../../utils/storageSizing.js';

/** Unique to this run, so concurrent runs and leftover data cannot interfere. */
const PREFIX = `tma-test/${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;

const written = new Set();
let tmpDir;

const key = name => {
  const full = `${PREFIX}/${name}`;
  written.add(full);
  return full;
};

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

beforeAll(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tma-s3-'));
});

afterAll(async () => {
  // Best effort: a failed test must not leave objects behind.
  await deleteObjects([...written]).catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('driver configuration', () => {
  it('is pointed at the configured bucket', () => {
    expect(s3.bucket).toBeTruthy();
    expect(s3.endpoint).toMatch(/^https?:\/\//);
  });
});

describe('putBuffer and getReadStream', () => {
  it('round-trips a buffer', async () => {
    const k = key('round-trip.bin');
    await putBuffer(k, Buffer.from('hello object storage'));

    expect((await collect(await getReadStream(k))).toString('utf8')).toBe('hello object storage');
  });

  it('overwrites an existing object', async () => {
    const k = key('overwrite.bin');
    await putBuffer(k, Buffer.from('first'));
    await putBuffer(k, Buffer.from('second'));

    expect((await collect(await getReadStream(k))).toString('utf8')).toBe('second');
  });

  it('stores an empty object', async () => {
    const k = key('empty.bin');
    await putBuffer(k, Buffer.alloc(0));

    expect(await statObject(k)).toMatchObject({ size: 0 });
  });

  it('round-trips binary content byte for byte', async () => {
    const k = key('binary.bin');
    const payload = crypto.randomBytes(64 * 1024);
    await putBuffer(k, payload);

    expect(Buffer.compare(await collect(await getReadStream(k)), payload)).toBe(0);
  });

  it('returns exactly an inclusive byte range', async () => {
    const k = key('range.bin');
    const payload = crypto.randomBytes(64 * 1024);
    await putBuffer(k, payload);

    const ranged = await collect(await getReadStream(k, { start: 123, end: 4567 }));

    expect(Buffer.compare(ranged, payload.subarray(123, 4568))).toBe(0);
  });
});

describe('exists', () => {
  it('reports true for a stored object', async () => {
    const k = key('present.bin');
    await putBuffer(k, Buffer.from('x'));

    expect(await exists(k)).toBe(true);
  });

  it('reports false for a missing object', async () => {
    expect(await exists(`${PREFIX}/never-written.bin`)).toBe(false);
  });
});

describe('putStream', () => {
  it('uploads from a readable stream', async () => {
    const k = key('streamed.bin');
    await putStream(k, Readable.from([Buffer.from('chunk-a'), Buffer.from('chunk-b')]));

    expect((await collect(await getReadStream(k))).toString('utf8')).toBe('chunk-achunk-b');
  });

  it('uploads an unknown-length payload through genuine multipart', async () => {
    const k = key('large.bin');
    const payload = crypto.randomBytes(DEFAULT_UPLOAD_PART_SIZE + 1024);
    await putStream(k, Readable.from([payload]));

    expect((await statObject(k)).size).toBe(payload.length);
    expect(Buffer.compare(await collect(await getReadStream(k)), payload)).toBe(0);
  });
});

describe('putFromPath', () => {
  it('uploads a local file', async () => {
    const local = path.join(tmpDir, 'source.bin');
    await fs.writeFile(local, 'from local disk');
    const k = key('from-path.bin');

    await putFromPath(k, local);

    expect((await collect(await getReadStream(k))).toString('utf8')).toBe('from local disk');
  });
});

describe('copyObject', () => {
  it('duplicates an object under a new key', async () => {
    const src = key('copy-source.bin');
    const dst = key('copy-dest.bin');
    await putBuffer(src, Buffer.from('payload'));

    await copyObject(src, dst);

    expect((await collect(await getReadStream(dst))).toString('utf8')).toBe('payload');
  });

  it('leaves the source in place', async () => {
    const src = key('copy-source-2.bin');
    const dst = key('copy-dest-2.bin');
    await putBuffer(src, Buffer.from('payload'));

    await copyObject(src, dst);

    expect(await exists(src)).toBe(true);
  });

  it('duplicates an object through the multipart-copy API sequence', async () => {
    const src = key('multipart-copy-source.bin');
    const dst = key('multipart-copy-dest.bin');
    const payload = crypto.randomBytes(6 * 1024 * 1024);
    await putBuffer(src, payload);

    await multipartCopyObject(src, dst, payload.length);

    expect(Buffer.compare(await collect(await getReadStream(dst)), payload)).toBe(0);
  });
});

describe('deleteObject', () => {
  it('removes the object', async () => {
    const k = key('doomed.bin');
    await putBuffer(k, Buffer.from('x'));

    await deleteObject(k);

    expect(await exists(k)).toBe(false);
  });

  it('is not an error to delete something that is already gone', async () => {
    await expect(deleteObject(`${PREFIX}/never-existed.bin`)).resolves.not.toThrow();
  });
});

describe('deleteObjects', () => {
  it('deletes a batch and tolerates duplicate and missing keys', async () => {
    const first = key('batch-delete-a.bin');
    const second = key('batch-delete-b.bin');
    const missing = `${PREFIX}/batch-delete-missing.bin`;
    await Promise.all([putBuffer(first, Buffer.from('a')), putBuffer(second, Buffer.from('b'))]);

    const result = await deleteObjects([first, second, first, missing]);

    expect(result.errors).toEqual([]);
    expect(result.deleted).toEqual(expect.arrayContaining([first, second, missing]));
    await expect(Promise.all([exists(first), exists(second)])).resolves.toEqual([false, false]);
  });
});

describe('statObject', () => {
  it('reports size and last-modified time', async () => {
    const k = key('stat.bin');
    await putBuffer(k, Buffer.from('twelve bytes'));

    const stats = await statObject(k);

    expect(stats.size).toBe(12);
    expect(stats.lastModified).toBeInstanceOf(Date);
  });

  it('returns null for a missing object rather than throwing', async () => {
    expect(await statObject(`${PREFIX}/missing.bin`)).toBeNull();
  });
});

describe('listObjectsPaginated', () => {
  it('finds the objects this run wrote', async () => {
    const k = key('listed.bin');
    await putBuffer(k, Buffer.from('x'));

    const seen = [];
    for await (const page of listObjectsPaginated(1000)) {
      seen.push(...page.filter(o => o.key.startsWith(PREFIX)));
    }

    expect(seen.map(o => o.key)).toContain(k);
  });

  it('reports a size and timestamp for each entry', async () => {
    const k = key('listed-2.bin');
    await putBuffer(k, Buffer.from('abcde'));

    let found;
    for await (const page of listObjectsPaginated(1000)) {
      found = page.find(o => o.key === k) || found;
    }

    expect(found.size).toBe(5);
    expect(found.lastModified).toBeInstanceOf(Date);
  });
});

describe('encryption over object storage', () => {
  it('stores ciphertext that decrypts back to the original', async () => {
    const k = key('encrypted.bin');
    const plaintext = 'sensitive content stored in the bucket';

    await putStream(k, Readable.from([Buffer.from(plaintext)]).pipe(createEncryptStream()));

    const { stream } = await createDecryptStreamFromStream(await getReadStream(k));
    expect((await collect(stream)).toString('utf8')).toBe(plaintext);
  });

  it('never leaves the plaintext visible in the stored object', async () => {
    const k = key('encrypted-2.bin');
    const marker = 'SUPER-SECRET-BUCKET-MARKER';

    await putStream(k, Readable.from([Buffer.from(marker)]).pipe(createEncryptStream()));

    const stored = await collect(await getReadStream(k));
    expect(stored.toString('latin1')).not.toContain(marker);
  });

  it('round-trips a large encrypted payload', async () => {
    const k = key('encrypted-large.bin');
    const payload = crypto.randomBytes(2 * 1024 * 1024);

    await putStream(k, Readable.from([payload]).pipe(createEncryptStream()));

    const { stream } = await createDecryptStreamFromStream(await getReadStream(k));
    expect(Buffer.compare(await collect(stream), payload)).toBe(0);
  });
});
