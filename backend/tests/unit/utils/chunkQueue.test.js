import { describe, it, expect } from 'vitest';

import { ChunkQueue } from '../../../utils/fileEncryption/chunkQueue.js';

describe('ChunkQueue', () => {
  it('returns exact slices across chunk boundaries in order', () => {
    const q = new ChunkQueue();
    q.push(Buffer.from('abc'));
    q.push(Buffer.from(''));
    q.push(Buffer.from('defgh'));
    q.push(Buffer.from('ij'));
    expect(q.length).toBe(10);
    expect(q.take(2).toString()).toBe('ab');
    expect(q.take(5).toString()).toBe('cdefg');
    expect(q.length).toBe(3);
    expect(q.takeAll().toString()).toBe('hij');
    expect(q.length).toBe(0);
  });

  it('slices without copying when one chunk covers the take', () => {
    const q = new ChunkQueue();
    const src = Buffer.from('hello world');
    q.push(src);
    const out = q.take(5);
    expect(out.buffer).toBe(src.buffer);
    expect(q.takeAll().toString()).toBe(' world');
  });

  it('takeAll on an empty queue yields an empty buffer', () => {
    expect(new ChunkQueue().takeAll().length).toBe(0);
  });
});
