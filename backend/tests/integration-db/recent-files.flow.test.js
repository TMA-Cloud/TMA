/**
 * The dashboard's "recently opened" list, end to end.
 *
 * Two separate claims are under test. The first is behavioural: the list is
 * ordered by when things were opened, it holds files rather than the folders
 * the user clicked through to reach them, and it notices an access soon after
 * one happens. The second is about cost — the query has to be a bounded walk of
 * idx_files_user_accessed_at rather than a scan and sort of the account, which
 * is the difference between a panel that stays cheap at three hundred files and
 * one that stops being cheap at three hundred thousand.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { flushAccessTimes, resetAccessTracker } from '../../services/accessTracker.js';
import { ensureOwner } from './helpers/app.js';

/** Upload a buffer through the real multipart endpoint. */
function upload(c, name) {
  return c.post('/api/files/upload').attach('file', Buffer.from('hello world'), {
    filename: name,
    contentType: 'text/plain',
  });
}

/** Open a file the way a user does, and let the write-behind buffer land. */
async function open(c, id) {
  await c.get(`/api/files/${id}/download`);
  await flushAccessTimes();
}

/** Push a row's access time into the past so ordering is unambiguous. */
function backdate(id, minutes) {
  return pool.query(`UPDATE files SET accessed_at = NOW() - INTERVAL '${minutes} minutes' WHERE id = $1`, [id]);
}

async function recent(c, limit) {
  const res = await c.get(limit ? `/api/files/recent?limit=${limit}` : '/api/files/recent');
  expect(res.status).toBe(200);
  return res.body;
}

beforeEach(() => {
  // The tracker's buffer and suppression windows outlive a single test.
  resetAccessTracker();
});

describe('GET /api/files/recent', () => {
  it('returns files most recently opened first', async () => {
    const { client: c } = await ensureOwner();
    const first = (await upload(c, 'first.txt')).body.id;
    const second = (await upload(c, 'second.txt')).body.id;
    await backdate(first, 60);
    await backdate(second, 30);

    await open(c, first);

    const names = (await recent(c)).map(f => f.name);
    expect(names.slice(0, 2)).toEqual(['first.txt', 'second.txt']);
  });

  it('leaves out the folders the user browsed on the way', async () => {
    const { client: c } = await ensureOwner();
    const folderId = (await c.post('/api/files/folder').send({ name: 'Papers' })).body.folder?.id;
    await upload(c, 'paper.txt');

    // Listing a folder stamps the folder, which would otherwise put it top.
    await c.get(`/api/files?parentId=${folderId}`);
    await flushAccessTimes();

    const body = await recent(c);
    expect(body.every(f => f.type === 'file')).toBe(true);
  });

  it('drops a file once it is in the trash', async () => {
    const { client: c } = await ensureOwner();
    const id = (await upload(c, 'doomed.txt')).body.id;
    expect((await recent(c)).some(f => f.id === id)).toBe(true);

    await c.post('/api/files/delete').send({ ids: [id] });

    expect((await recent(c)).some(f => f.id === id)).toBe(false);
  });

  it('honours the limit, and holds the line against an absurd one', async () => {
    const { client: c } = await ensureOwner();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) await upload(c, name);

    expect(await recent(c, 2)).toHaveLength(2);
    expect((await recent(c, 100000)).length).toBeLessThanOrEqual(3);
  });

  it('reflects a fresh open rather than serving the list it cached a moment ago', async () => {
    const { client: c } = await ensureOwner();
    const older = (await upload(c, 'older.txt')).body.id;
    const newer = (await upload(c, 'newer.txt')).body.id;
    await backdate(older, 60);
    await backdate(newer, 30);

    // Warm the cache with the pre-access order, then change it.
    expect((await recent(c))[0].name).toBe('newer.txt');
    await open(c, older);

    // The tracker drops the key as part of its flush, so the next read is right
    // immediately instead of waiting out a TTL.
    expect((await recent(c))[0].name).toBe('older.txt');
  });

  it('does not leak one account list into another', async () => {
    const { client: a } = await ensureOwner();
    await upload(a, 'private.txt');
    const { client: b } = await ensureOwner();

    expect((await recent(b)).some(f => f.name === 'private.txt')).toBe(false);
  });

  it('refuses an anonymous caller', async () => {
    const { client: anon } = await ensureOwner();
    await anon.post('/api/logout');

    expect((await anon.get('/api/files/recent')).status).toBe(401);
  });
});

describe('the query plan', () => {
  /**
   * Clone one real row many times, varying only id and access time.
   *
   * Copying through jsonb_populate_record keeps the seed independent of the
   * files table's column list, which has grown across thirty-odd migrations and
   * will grow again.
   */
  async function seedRows(templateId, count) {
    await pool.query(
      `INSERT INTO files
       SELECT (jsonb_populate_record(
                 f,
                 jsonb_build_object(
                   'id', 'seed-' || g,
                   'name', 'seed-' || g || '.txt',
                   'path', '/seed-' || g || '.txt',
                   'accessed_at', (NOW() - (g || ' seconds')::interval)
                 )
               )).*
         FROM files f, generate_series(1, $2) AS g
        WHERE f.id = $1`,
      [templateId, count]
    );
  }

  it('walks the access-time index and stops at the limit, instead of sorting the account', async () => {
    const { client: c, user } = await ensureOwner();
    const templateId = (await upload(c, 'template.txt')).body.id;
    await seedRows(templateId, 5000);
    // Without fresh statistics the planner is guessing at row counts, and the
    // plan it prints would say more about ANALYZE than about the index.
    await pool.query('ANALYZE files');

    const { rows } = await pool.query(
      `EXPLAIN (FORMAT JSON)
       SELECT id, name, type, size, modified, accessed_at
         FROM files
        WHERE user_id = $1 AND deleted_at IS NULL AND type = 'file'
        ORDER BY accessed_at DESC
        LIMIT 50`,
      [user.id]
    );

    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
    expect(plan).toContain('idx_files_user_accessed_at');
    // A Sort node here would mean the whole account was read and ordered before
    // the fifty rows came off the top.
    expect(plan).not.toContain('"Sort"');
    expect(plan).not.toContain('Seq Scan');
  });
});
