import { Readable, Writable } from 'stream';

import { describe, expect, it, vi } from 'vitest';

const sources = [];

vi.mock('../../../utils/storageDriver.js', () => ({
  default: {
    getReadStream: vi.fn(async () => {
      let n = 0;
      const stream = new Readable({
        read() {
          this.push(n++ < 5000 ? Buffer.alloc(65536) : null);
        },
      });
      sources.push(stream);
      return stream;
    }),
  },
}));

vi.mock('../../../models/file/file.dek.model.js', () => ({ resolveIkmForPath: vi.fn() }));

vi.mock('../../../utils/fileEncryption.js', () => ({
  resolveIkm: vi.fn(() => Buffer.alloc(32)),
  createDecryptStreamFromStream: vi.fn(async readStream => ({ stream: readStream, cleanup: () => {} })),
}));

const { createStreamingZipArchive } = await import('../../../utils/zipArchive.js');

function slowResponse() {
  const res = new Writable({
    highWaterMark: 16384,
    write(_chunk, _enc, cb) {
      setTimeout(cb, 2);
    },
  });
  res.setHeader = () => {};
  res.status = () => res;
  res.json = () => res;
  return res;
}

describe('createStreamingZipArchive', () => {
  it('stops and releases the entry source when the client disconnects', async () => {
    const res = slowResponse();
    let released = false;
    async function* entries() {
      try {
        yield { id: 'a', type: 'file', path: 'a.bin', archivePath: 'a.bin', dekWrapped: Buffer.alloc(60) };
        yield { id: 'b', type: 'file', path: 'b.bin', archivePath: 'b.bin', dekWrapped: Buffer.alloc(60) };
      } finally {
        released = true;
      }
    }

    const done = createStreamingZipArchive(res, 'folder', entries());
    setTimeout(() => res.destroy(), 50);

    await expect(done).resolves.toBeUndefined();
    expect(released).toBe(true);
    expect(sources).toHaveLength(1);
    expect(sources[0].destroyed).toBe(true);
  });
});
