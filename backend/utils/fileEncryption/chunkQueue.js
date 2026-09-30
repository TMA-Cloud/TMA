/**
 * FIFO of incoming stream chunks that hands out exact-size slices. Concatenating
 * on every chunk re-copies the growing buffer (~8-16x per 1 MiB segment); this
 * copies each byte at most once, and not at all when one chunk covers the take.
 */
class ChunkQueue {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  push(chunk) {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  /** Remove and return the first `n` bytes (caller ensures n <= length). */
  take(n) {
    const first = this.chunks[0];
    if (first && first.length >= n) {
      this.length -= n;
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      return first.subarray(0, n);
    }

    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0];
      const used = Math.min(chunk.length, n - filled);
      chunk.copy(out, filled, 0, used);
      filled += used;
      if (used === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(used);
    }
    this.length -= n;
    return out;
  }

  /** Remove and return everything buffered. */
  takeAll() {
    return this.take(this.length);
  }
}

export { ChunkQueue };
