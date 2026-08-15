import { describe, expect, it } from 'vitest';

import { executedCalls, queueQueryResults } from '../../mocks/db.mock.js';
import { redisStore, setRedisDown } from '../../mocks/redis.mock.js';
import { RECENT_CACHE_SIZE, getRecentFiles } from '../../../models/file/file.search.model.js';

const USER = 'user000000000001';

/** Rows shaped like the columns the recent query selects. */
function rows(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `file${i}`,
    name: `file${i}.txt`,
    type: 'file',
    size: 10,
    accessedAt: new Date(Date.now() - i * 1000).toISOString(),
  }));
}

/** The SELECT statements run against `files`, in order. */
function selects() {
  return executedCalls().filter(call => call.sql.includes('FROM files'));
}

describe('getRecentFiles', () => {
  it('orders by last opened and asks the database for only a page', async () => {
    queueQueryResults({ rows: rows(3), rowCount: 3 });
    await getRecentFiles(USER, 5);

    const [{ sql, params }] = selects();
    expect(sql).toMatch(/ORDER BY accessed_at DESC/);
    expect(sql).toMatch(/LIMIT \$2/);
    expect(params).toEqual([USER, RECENT_CACHE_SIZE]);
  });

  it('leaves out folders and trashed rows', async () => {
    queueQueryResults({ rows: [], rowCount: 0 });
    await getRecentFiles(USER, 5);

    const [{ sql }] = selects();
    expect(sql).toMatch(/type = 'file'/);
    expect(sql).toMatch(/deleted_at IS NULL/);
  });

  it('scopes the query to the account', async () => {
    queueQueryResults({ rows: [], rowCount: 0 });
    await getRecentFiles(USER, 5);

    expect(selects()[0].sql).toMatch(/user_id = \$1/);
  });

  it('returns the number of rows the caller asked for', async () => {
    queueQueryResults({ rows: rows(20), rowCount: 20 });
    const files = await getRecentFiles(USER, 5);

    expect(files).toHaveLength(5);
    expect(files[0].id).toBe('file0');
  });

  it('caps a limit larger than the cached page rather than querying again', async () => {
    queueQueryResults({ rows: rows(RECENT_CACHE_SIZE), rowCount: RECENT_CACHE_SIZE });
    const files = await getRecentFiles(USER, 10000);

    expect(files).toHaveLength(RECENT_CACHE_SIZE);
    expect(selects()).toHaveLength(1);
  });

  it('treats a junk limit as one row instead of failing the panel', async () => {
    queueQueryResults({ rows: rows(5), rowCount: 5 });
    expect(await getRecentFiles(USER, Number.NaN)).toHaveLength(1);
  });

  describe('caching', () => {
    it('serves a second call from one cache entry, whatever the limit', async () => {
      queueQueryResults({ rows: rows(20), rowCount: 20 });

      expect(await getRecentFiles(USER, 5)).toHaveLength(5);
      expect(await getRecentFiles(USER, 10)).toHaveLength(10);

      // A per-limit key would have missed on the second call and queried again.
      expect(selects()).toHaveLength(1);
      expect([...redisStore().keys()].filter(k => k.includes(':recent'))).toEqual([`files:${USER}:recent`]);
    });

    it('keeps one account out of the next account list', async () => {
      queueQueryResults({ rows: rows(2), rowCount: 2 }, { rows: rows(4), rowCount: 4 });

      await getRecentFiles(USER, 5);
      expect(await getRecentFiles('user000000000002', 5)).toHaveLength(4);
      expect(selects()).toHaveLength(2);
    });

    it('still answers when the cache is unavailable', async () => {
      setRedisDown(true);
      queueQueryResults({ rows: rows(3), rowCount: 3 });

      expect(await getRecentFiles(USER, 5)).toHaveLength(3);
    });
  });
});
