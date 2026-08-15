import { beforeEach, describe, expect, it } from 'vitest';

import { executedCalls, queueQueryResults, resetDbMock } from '../../mocks/db.mock.js';
import { seedRedis, setRedisDown } from '../../mocks/redis.mock.js';
import { cacheKeys, getCache } from '../../../utils/cache.js';
import { CHUNK_SIZE, flushAccessTimes, recordAccess, resetAccessTracker } from '../../../services/accessTracker.js';

const OWNER = 'user000000000001';
const OTHER = 'user000000000002';

beforeEach(() => {
  resetDbMock();
  resetAccessTracker();
});

/** The UPDATE statements the tracker ran, in order. */
function updates() {
  return executedCalls().filter(call => call.sql.includes('UPDATE files'));
}

describe('recordAccess', () => {
  it('writes nothing until a flush, so a read never waits on a write', async () => {
    recordAccess('file1', OWNER);
    expect(updates()).toHaveLength(0);

    await flushAccessTimes();
    expect(updates()).toHaveLength(1);
  });

  it('collapses a burst of reads into a single statement', async () => {
    recordAccess(['file1', 'file2', 'file3'], OWNER);
    await flushAccessTimes();

    expect(updates()).toHaveLength(1);
    expect(updates()[0].params).toHaveLength(9); // three ids x (id, owner, timestamp)
  });

  it('ignores a re-read inside the suppression window', async () => {
    recordAccess('file1', OWNER);
    await flushAccessTimes();

    for (let i = 0; i < 20; i++) {
      recordAccess('file1', OWNER);
    }
    await flushAccessTimes();

    expect(updates()).toHaveLength(1);
  });

  it('keeps accounts apart, so one owner cannot suppress another', async () => {
    recordAccess('file1', OWNER);
    recordAccess('file1', 'user000000000002');
    await flushAccessTimes();

    expect(updates()[0].params).toContain('user000000000002');
  });

  it('does nothing without an owner rather than throwing on a read path', async () => {
    expect(() => recordAccess('file1', undefined)).not.toThrow();
    expect(() => recordAccess(null, OWNER)).not.toThrow();
    expect(() => recordAccess([], OWNER)).not.toThrow();

    await flushAccessTimes();
    expect(updates()).toHaveLength(0);
  });
});

describe('the flushed statement', () => {
  it('leaves `modified` alone', async () => {
    recordAccess('file1', OWNER);
    await flushAccessTimes();

    expect(updates()[0].sql).not.toMatch(/\bmodified\b/);
  });

  it('skips deleted rows and refuses to move a timestamp backwards', async () => {
    recordAccess('file1', OWNER);
    await flushAccessTimes();

    const { sql } = updates()[0];
    expect(sql).toContain('f.deleted_at IS NULL');
    expect(sql).toContain('f.accessed_at < v.accessed_at');
  });

  it('matches on the owner as well as the id', async () => {
    recordAccess('file1', OWNER);
    await flushAccessTimes();

    expect(updates()[0].sql).toContain('f.user_id = v.user_id');
  });

  it('splits a large batch into bounded statements', async () => {
    const ids = Array.from({ length: CHUNK_SIZE + 10 }, (_, i) => `file${i}`);
    recordAccess(ids, OWNER);
    await flushAccessTimes();

    expect(updates()).toHaveLength(2);
    expect(updates()[0].params).toHaveLength(CHUNK_SIZE * 3);
    expect(updates()[1].params).toHaveLength(10 * 3);
  });
});

describe('when the database rejects the flush', () => {
  it('swallows the error instead of surfacing it on a read path', async () => {
    queueQueryResults(new Error('connection lost'));
    recordAccess('file1', OWNER);

    await expect(flushAccessTimes()).resolves.toBe(0);
  });

  it('lets the next read retry rather than staying silent for the window', async () => {
    queueQueryResults(new Error('connection lost'));
    recordAccess('file1', OWNER);
    await flushAccessTimes();

    // The suppression window was never earned: nothing reached the table.
    recordAccess('file1', OWNER);
    await flushAccessTimes();

    expect(updates()).toHaveLength(2);
  });
});

describe('the cached recent-files list', () => {
  it('is dropped for every account in the batch once the write lands', async () => {
    seedRedis(cacheKeys.recentFiles(OWNER), [{ id: 'file1' }]);
    seedRedis(cacheKeys.recentFiles(OTHER), [{ id: 'file2' }]);
    queueQueryResults({ rows: [], rowCount: 2 });

    recordAccess('file1', OWNER);
    recordAccess('file2', OTHER);
    await flushAccessTimes();

    expect(await getCache(cacheKeys.recentFiles(OWNER))).toBeNull();
    expect(await getCache(cacheKeys.recentFiles(OTHER))).toBeNull();
  });

  it('survives a cache that is down, because a read must not fail on it', async () => {
    queueQueryResults({ rows: [], rowCount: 1 });
    setRedisDown(true);

    recordAccess('file1', OWNER);
    await expect(flushAccessTimes()).resolves.toBe(1);
  });

  it('is left alone when no row actually moved forward', async () => {
    seedRedis(cacheKeys.recentFiles(OWNER), [{ id: 'file1' }]);
    queueQueryResults({ rows: [], rowCount: 0 });

    recordAccess('file1', OWNER);
    await flushAccessTimes();

    // Every id was already inside its window on the row itself, so the list the
    // cache holds is still the right one.
    expect(await getCache(cacheKeys.recentFiles(OWNER))).not.toBeNull();
  });
});

describe('flushAccessTimes', () => {
  it('is a no-op when nothing was read', async () => {
    await flushAccessTimes();
    expect(updates()).toHaveLength(0);
  });

  it('does not replay a batch it already wrote', async () => {
    recordAccess('file1', OWNER);
    await flushAccessTimes();
    await flushAccessTimes();

    expect(updates()).toHaveLength(1);
  });
});
