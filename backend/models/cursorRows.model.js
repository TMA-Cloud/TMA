/**
 * Stream a long-lived cursor query (e.g. a ZIP's file tree) without letting slow
 * consumers starve the connection pool. Results up to PREFETCH_ROWS are read
 * eagerly so the connection goes back to the pool in milliseconds; only larger
 * results keep it for the life of the stream, and those are capped process-wide.
 */

import { Semaphore } from 'async-mutex';

const PREFETCH_ROWS = 20000;
const heldCursorSlots = new Semaphore(Math.max(1, Number(process.env.DB_HELD_CURSOR_LIMIT) || 3));

/**
 * @param {import('pg').Pool} pool
 * @param {import('pg-cursor')} cursorQuery - A `new Cursor(sql, params)`
 * @param {number} [batchSize]
 */
async function* streamCursorRows(pool, cursorQuery, batchSize = 200) {
  let releaseSlot = (await heldCursorSlots.acquire())[1];
  let client = null;
  let cursor = null;

  const releaseAll = async () => {
    if (cursor) {
      const open = cursor;
      cursor = null;
      await open.close().catch(() => {});
    }
    if (client) {
      client.release();
      client = null;
    }
    if (releaseSlot) {
      releaseSlot();
      releaseSlot = null;
    }
  };

  try {
    client = await pool.connect();
    cursor = client.query(cursorQuery);

    const head = [];
    let exhausted = false;
    while (head.length < PREFETCH_ROWS) {
      const rows = await cursor.read(batchSize);
      if (rows.length === 0) {
        exhausted = true;
        break;
      }
      for (const row of rows) head.push(row);
    }
    if (exhausted) await releaseAll();

    for (const row of head) yield row;
    while (cursor) {
      const rows = await cursor.read(batchSize);
      if (rows.length === 0) break;
      for (const row of rows) yield row;
    }
  } finally {
    await releaseAll();
  }
}

export { streamCursorRows, PREFETCH_ROWS };
