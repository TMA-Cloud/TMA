import { describe, it, expect } from 'vitest';
import { consumeNdjsonProgress } from '../../src/utils/progressStream';

/** A Response whose body streams `text` in two chunks, to exercise line-buffer joining. */
function streamResponse(text: string): Response {
  const bytes = new TextEncoder().encode(text);
  const mid = Math.floor(bytes.length / 2);
  const chunks = [bytes.slice(0, mid), bytes.slice(mid)];
  let i = 0;
  return {
    body: {
      getReader() {
        return {
          read() {
            if (i >= chunks.length) return Promise.resolve({ done: true, value: undefined });
            return Promise.resolve({ done: false, value: chunks[i++] });
          },
        };
      },
    },
  } as unknown as Response;
}

const ndjson = (lines: unknown[]) => lines.map(l => JSON.stringify(l)).join('\n') + '\n';

describe('consumeNdjsonProgress', () => {
  it('reports real percentages (capped at 99) and returns the done payload', async () => {
    const res = streamResponse(
      ndjson([
        { type: 'progress', done: 0, total: 4 },
        { type: 'progress', done: 2, total: 4 },
        { type: 'progress', done: 4, total: 4 },
        { type: 'done', message: 'ok' },
      ])
    );

    const percents: number[] = [];
    const done = await consumeNdjsonProgress(res, p => percents.push(p));

    expect(percents).toEqual([0, 50, 99]); // 4/4 rounds to 100 but is held at 99 until finalize
    expect(done).toEqual({ type: 'done', message: 'ok' });
  });

  it('throws with the server message on an error line', async () => {
    const res = streamResponse(
      ndjson([
        { type: 'progress', done: 1, total: 2 },
        { type: 'error', message: 'boom' },
      ])
    );

    await expect(consumeNdjsonProgress(res, () => {})).rejects.toThrow('boom');
  });
});
