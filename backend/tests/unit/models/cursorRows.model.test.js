import { describe, expect, it, vi } from 'vitest';

import { PREFETCH_ROWS, streamCursorRows } from '../../../models/cursorRows.model.js';

function fakePool(totalRows) {
  const client = { release: vi.fn() };
  let served = 0;
  const cursor = {
    read: vi.fn(async n => {
      const rows = [];
      while (rows.length < n && served < totalRows) rows.push({ i: served++ });
      return rows;
    }),
    close: vi.fn(async () => {}),
  };
  client.query = () => cursor;
  return { pool: { connect: vi.fn(async () => client) }, client, cursor };
}

describe('streamCursorRows', () => {
  it('releases the connection before yielding when the result fits the prefetch', async () => {
    const { pool, client } = fakePool(450);
    const it = streamCursorRows(pool, {});
    const first = await it.next();
    expect(first.value).toEqual({ i: 0 });
    expect(client.release).toHaveBeenCalledTimes(1);
    let count = 1;
    for await (const _row of it) count += 1;
    expect(count).toBe(450);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('keeps streaming past the prefetch and releases once at the end', async () => {
    const { pool, client, cursor } = fakePool(PREFETCH_ROWS + 500);
    const it = streamCursorRows(pool, {});
    await it.next();
    expect(client.release).not.toHaveBeenCalled();
    let count = 1;
    for await (const _row of it) count += 1;
    expect(count).toBe(PREFETCH_ROWS + 500);
    expect(cursor.close).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('releases when the consumer stops early', async () => {
    const { pool, client } = fakePool(PREFETCH_ROWS + 500);
    for await (const _row of streamCursorRows(pool, {})) break;
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
