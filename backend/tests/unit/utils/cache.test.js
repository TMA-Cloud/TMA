import { describe, expect, it } from 'vitest';

import { redisStore, seedRedis, setRedisDown } from '../../mocks/redis.mock.js';
import {
  DEFAULT_TTL,
  cacheKeys,
  deleteCache,
  deleteCachePattern,
  getCache,
  invalidateAllFileCaches,
  invalidateEmailCache,
  invalidateFileCache,
  invalidateSearchCache,
  invalidateShareCache,
  invalidateUserCache,
  setCache,
} from '../../../utils/cache.js';

const USER = 'user000000000001';

describe('get/set round trip', () => {
  it('stores and returns a value', async () => {
    await setCache('k', { a: 1 });
    expect(await getCache('k')).toEqual({ a: 1 });
  });

  it('returns null for a key that was never set', async () => {
    expect(await getCache('missing')).toBeNull();
  });

  it('preserves types through JSON serialisation', async () => {
    await setCache('arr', [1, 'two', null]);
    await setCache('num', 42);
    await setCache('bool', false);
    await setCache('str', 'hello');
    expect(await getCache('arr')).toEqual([1, 'two', null]);
    expect(await getCache('num')).toBe(42);
    expect(await getCache('bool')).toBe(false);
    expect(await getCache('str')).toBe('hello');
  });

  it('round-trips a stored null without confusing it with a miss', async () => {
    await setCache('nullish', null);
    expect(redisStore().has('nullish')).toBe(true);
    expect(await getCache('nullish')).toBeNull();
  });

  it('applies the default TTL when none is given', async () => {
    const before = Date.now();
    await setCache('k', 'v');
    const entry = redisStore().get('k');
    expect(entry.expiresAt).toBeGreaterThanOrEqual(before + DEFAULT_TTL * 1000 - 50);
  });

  it('applies an explicit TTL', async () => {
    const before = Date.now();
    await setCache('k', 'v', 60);
    expect(redisStore().get('k').expiresAt).toBeLessThanOrEqual(before + 60_000 + 50);
  });

  it('treats an expired entry as a miss', async () => {
    seedRedis('stale', '"value"', -1);
    expect(await getCache('stale')).toBeNull();
  });

  it('returns null rather than throwing when the stored value is not JSON', async () => {
    seedRedis('broken', 'not-json-at-all');
    expect(await getCache('broken')).toBeNull();
  });
});

describe('degraded mode without Redis', () => {
  it('reads return null', async () => {
    await setCache('k', 'v');
    setRedisDown(true);
    expect(await getCache('k')).toBeNull();
  });

  it('writes report failure instead of throwing', async () => {
    setRedisDown(true);
    expect(await setCache('k', 'v')).toBe(false);
  });

  it('deletes report failure', async () => {
    setRedisDown(true);
    expect(await deleteCache('k')).toBe(false);
  });

  it('pattern deletes report zero keys removed', async () => {
    setRedisDown(true);
    expect(await deleteCachePattern('files:*')).toBe(0);
  });
});

describe('deleteCache', () => {
  it('removes a single key', async () => {
    await setCache('k', 'v');
    expect(await deleteCache('k')).toBe(true);
    expect(await getCache('k')).toBeNull();
  });

  it('reports success even when the key was already gone', async () => {
    expect(await deleteCache('never-existed')).toBe(true);
  });
});

describe('deleteCachePattern', () => {
  it('removes every key matching the glob and leaves the rest alone', async () => {
    await setCache(`files:${USER}:root:name:ASC`, 1);
    await setCache(`files:${USER}:root:size:DESC`, 2);
    await setCache('files:other:root:name:ASC', 3);

    const deleted = await deleteCachePattern(`files:${USER}:*`);

    expect(deleted).toBe(2);
    expect(await getCache('files:other:root:name:ASC')).toBe(3);
  });

  it('returns zero when nothing matches', async () => {
    await setCache('unrelated', 1);
    expect(await deleteCachePattern('files:*')).toBe(0);
  });

  it('iterates the full keyspace across multiple SCAN pages', async () => {
    for (let i = 0; i < 250; i++) {
      await setCache(`files:${USER}:folder${i}`, i);
    }
    expect(await deleteCachePattern(`files:${USER}:*`)).toBe(250);
    expect(await getCache(`files:${USER}:folder249`)).toBeNull();
  });
});

describe('invalidation helpers', () => {
  it('invalidateEmailCache removes the hashed lookup key', async () => {
    const key = cacheKeys.userByEmail('User@Example.com');
    await setCache(key, { id: USER });
    await invalidateEmailCache('user@example.com');
    expect(await getCache(key)).toBeNull();
  });

  it('invalidateUserCache clears files, user, storage, search and share entries', async () => {
    await setCache(`files:${USER}:root:name:ASC`, 1);
    await setCache(`user:${USER}:id`, 2);
    await setCache(`storage:${USER}:usage`, 3);
    await setCache(`search:${USER}:hash:100`, 4);
    await setCache(`share:${USER}:file1`, 5);
    await setCache(`files:other:root`, 6);

    const deleted = await invalidateUserCache(USER);

    expect(deleted).toBe(5);
    expect(await getCache('files:other:root')).toBe(6);
  });

  it('invalidateFileCache with a parent also drops the root listing, to be safe', async () => {
    await setCache(`files:${USER}:parent1:name:ASC`, 1);
    await setCache(`files:${USER}:root:name:ASC`, 2);
    await invalidateFileCache(USER, 'parent1');
    expect(await getCache(`files:${USER}:parent1:name:ASC`)).toBeNull();
    expect(await getCache(`files:${USER}:root:name:ASC`)).toBeNull();
  });

  it('invalidateFileCache without a parent drops every listing for the user', async () => {
    await setCache(`files:${USER}:a`, 1);
    await setCache(`files:${USER}:b`, 2);
    expect(await invalidateFileCache(USER)).toBe(2);
  });

  it('invalidateSearchCache touches only search entries', async () => {
    await setCache(`search:${USER}:hash:100`, 1);
    await setCache(`files:${USER}:root`, 2);
    await invalidateSearchCache(USER);
    expect(await getCache(`search:${USER}:hash:100`)).toBeNull();
    expect(await getCache(`files:${USER}:root`)).toBe(2);
  });

  describe('invalidateAllFileCaches', () => {
    it('clears listings, search, stats and storage in one call', async () => {
      await setCache(`files:${USER}:root:name:ASC`, 1);
      await setCache(`search:${USER}:hash:100`, 2);
      await setCache(cacheKeys.fileStats(USER), 3);
      await setCache(cacheKeys.userStorage(USER), 4);

      await invalidateAllFileCaches(USER);

      expect(await getCache(`files:${USER}:root:name:ASC`)).toBeNull();
      expect(await getCache(`search:${USER}:hash:100`)).toBeNull();
      expect(await getCache(cacheKeys.fileStats(USER))).toBeNull();
      expect(await getCache(cacheKeys.userStorage(USER))).toBeNull();
    });

    it('also clears the source folder on a move', async () => {
      await setCache(`files:${USER}:src:name:ASC`, 1);
      await setCache(`files:${USER}:dst:name:ASC`, 2);
      await invalidateAllFileCaches(USER, 'dst', { oldParentId: 'src' });
      expect(await getCache(`files:${USER}:src:name:ASC`)).toBeNull();
      expect(await getCache(`files:${USER}:dst:name:ASC`)).toBeNull();
    });

    it('keeps the storage entry when the caller opts out', async () => {
      await setCache(cacheKeys.userStorage(USER), 4);
      await invalidateAllFileCaches(USER, null, { includeStorage: false });
      expect(await getCache(cacheKeys.userStorage(USER))).toBe(4);
    });

    it('clears the stats entry even with includeStats: false, because it lives under the files: prefix', async () => {
      // cacheKeys.fileStats is `files:<user>:stats`, so invalidateFileCache's
      // `files:<user>:*` sweep takes it regardless of the flag. Opting out only
      // skips the redundant explicit delete.
      await setCache(cacheKeys.fileStats(USER), 3);
      await invalidateAllFileCaches(USER, null, { includeStats: false });
      expect(await getCache(cacheKeys.fileStats(USER))).toBeNull();
    });
  });

  describe('invalidateShareCache', () => {
    it('drops the token entry and its derived keys', async () => {
      await setCache(cacheKeys.shareByToken('tok123'), { id: 1 });
      await setCache('share:token:tok123:folder:root', { id: 2 });
      await invalidateShareCache('tok123');
      expect(await getCache(cacheKeys.shareByToken('tok123'))).toBeNull();
      expect(await getCache('share:token:tok123:folder:root')).toBeNull();
    });

    it('also drops the owner-scoped share entries when a user is given', async () => {
      await setCache(`share:${USER}:file1`, 1);
      await invalidateShareCache(null, USER);
      expect(await getCache(`share:${USER}:file1`)).toBeNull();
    });

    it('is a no-op when neither a token nor a user is supplied', async () => {
      await setCache('share:token:other', 1);
      expect(await invalidateShareCache(null, null)).toBe(0);
      expect(await getCache('share:token:other')).toBe(1);
    });
  });
});

describe('cacheKeys', () => {
  it('namespaces file listings by user, folder and sort', () => {
    expect(cacheKeys.files(USER, 'p1', 'name', 'ASC')).toBe(`files:${USER}:p1:name:ASC`);
  });

  it('uses "root" for a null parent', () => {
    expect(cacheKeys.files(USER, null)).toBe(`files:${USER}:root:modified:DESC`);
  });

  it('never puts a raw search query in the key', () => {
    const key = cacheKeys.search(USER, "'; DROP TABLE files; --");
    expect(key).not.toContain('DROP TABLE');
    expect(key).toMatch(new RegExp(`^search:${USER}:[0-9a-f]{16}:100$`));
  });

  it('normalises search queries so equivalent searches share a key', () => {
    expect(cacheKeys.search(USER, '  Invoice ')).toBe(cacheKeys.search(USER, 'invoice'));
  });

  it('separates different search queries', () => {
    expect(cacheKeys.search(USER, 'invoice')).not.toBe(cacheKeys.search(USER, 'receipt'));
  });

  it('separates search results by limit', () => {
    expect(cacheKeys.search(USER, 'x', 10)).not.toBe(cacheKeys.search(USER, 'x', 20));
  });

  it('never puts a raw email address in the key', () => {
    const key = cacheKeys.userByEmail('someone@example.com');
    expect(key).not.toContain('someone');
    expect(key).not.toContain('example.com');
    expect(key).toMatch(/^user:email:[0-9a-f]{16}$/);
  });

  it('normalises email case and whitespace to one key', () => {
    expect(cacheKeys.userByEmail('  User@Example.COM ')).toBe(cacheKeys.userByEmail('user@example.com'));
  });

  it('binds a session key to the token version so a bump invalidates it', () => {
    expect(cacheKeys.session('s1', USER, 1)).not.toBe(cacheKeys.session('s1', USER, 2));
  });

  it('keeps every user-scoped key under an invalidatable prefix', () => {
    const prefixes = [
      cacheKeys.files(USER),
      cacheKeys.starredFiles(USER),
      cacheKeys.sharedFiles(USER),
      cacheKeys.trashFiles(USER),
      cacheKeys.fileStats(USER),
    ];
    for (const key of prefixes) {
      expect(key.startsWith(`files:${USER}:`)).toBe(true);
    }
  });

  it('gives app-wide settings a distinct namespace from user data', () => {
    for (const key of [
      cacheKeys.signupEnabled(),
      cacheKeys.userCount(),
      cacheKeys.onlyOfficeSettings(),
      cacheKeys.shareBaseUrlSettings(),
      cacheKeys.maxUploadSizeSettings(),
      cacheKeys.hideFileExtensionsSettings(),
      cacheKeys.electronOnlyAccessSettings(),
      cacheKeys.passwordChangeSettings(),
    ]) {
      expect(key.startsWith('app:')).toBe(true);
    }
  });
});
