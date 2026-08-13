import { describe, expect, it } from 'vitest';

import { alwaysReturn, clientQuery, executedCalls, queueQueryResults } from '../../mocks/db.mock.js';
import { cacheKeys, getCache, setCache } from '../../../utils/cache.js';
import {
  getElectronOnlyAccessSettings,
  getMaxUploadSizeSettings,
  getUserStorageLimit,
  setUserStorageLimit,
} from '../../../models/user/user.admin.model.js';

const ADMIN = 'admin00000000001';
const TARGET = 'target0000000001';
const GB = 1024 * 1024 * 1024;

describe('getUserStorageLimit', () => {
  it('returns a numeric limit as-is', async () => {
    alwaysReturn({ rows: [{ storage_limit: 10 * GB }] });
    expect(await getUserStorageLimit(TARGET)).toBe(10 * GB);
  });

  it('converts a BIGINT returned as a string', async () => {
    alwaysReturn({ rows: [{ storage_limit: '10737418240' }] });
    expect(await getUserStorageLimit(TARGET)).toBe(10737418240);
  });

  it('reports null for an unlimited account', async () => {
    alwaysReturn({ rows: [{ storage_limit: null }] });
    expect(await getUserStorageLimit(TARGET)).toBeNull();
  });

  it('reports null for a user that does not exist', async () => {
    alwaysReturn({ rows: [] });
    expect(await getUserStorageLimit('nobody')).toBeNull();
  });

  it('reports null rather than NaN for an unparseable value', async () => {
    alwaysReturn({ rows: [{ storage_limit: 'not-a-number' }] });
    expect(await getUserStorageLimit(TARGET)).toBeNull();
  });

  it('parameterises the lookup', async () => {
    alwaysReturn({ rows: [] });
    await getUserStorageLimit(TARGET);
    expect(executedCalls()[0].params).toEqual([TARGET]);
  });
});

describe('setUserStorageLimit', () => {
  /**
   * Queue the statements setUserStorageLimit runs.
   *
   * Order: BEGIN, verifyFirstUser's app_settings lookup, target lookup,
   * usage lookup, UPDATE, COMMIT. Later entries are simply unused when a
   * validation error short-circuits the call.
   */
  function stub({ firstUserId = ADMIN, target = { parent_user_id: null }, used = 0 } = {}) {
    queueQueryResults(
      { rows: [] }, // BEGIN
      { rows: [{ first_user_id: firstUserId }] }, // verifyFirstUser
      { rows: target ? [target] : [] },
      { rows: [{ used: String(used) }] },
      { rows: [] }, // UPDATE
      { rows: [] } // COMMIT
    );
  }

  it('lets only the first user change a limit', async () => {
    stub({ firstUserId: 'someone-else' });
    await expect(setUserStorageLimit(ADMIN, TARGET, 10 * GB)).rejects.toThrow(/Only the first user/);
  });

  it.each([0, -1])('rejects the limit %i', async limit => {
    stub();
    await expect(setUserStorageLimit(ADMIN, TARGET, limit)).rejects.toThrow(/positive integer or null/);
  });

  it('rejects a non-integer limit', async () => {
    stub();
    await expect(setUserStorageLimit(ADMIN, TARGET, 1.5)).rejects.toThrow(/positive integer or null/);
  });

  it('rejects a limit above one petabyte', async () => {
    stub();
    const overPetabyte = 1024 * 1024 * 1024 * 1024 * 1024 + 1;
    await expect(setUserStorageLimit(ADMIN, TARGET, overPetabyte)).rejects.toThrow(/cannot exceed 1 Petabyte/);
  });

  it.each(['bad id!', 'has space', '', null])('rejects the malformed target id %p', async targetId => {
    stub();
    await expect(setUserStorageLimit(ADMIN, targetId, null)).rejects.toThrow(/Invalid targetUserId format/);
  });

  it('rolls back on a rejected limit rather than leaving the transaction open', async () => {
    stub();
    await expect(setUserStorageLimit(ADMIN, TARGET, -1)).rejects.toThrow();
    expect(clientQuery.mock.calls.map(c => c[0])).toContain('ROLLBACK');
  });

  it('rejects a target that does not exist', async () => {
    stub({ target: null });
    await expect(setUserStorageLimit(ADMIN, TARGET, null)).rejects.toThrow('User not found');
  });

  it('refuses to set a limit on a sub-user, since it would never be consulted', async () => {
    stub({ target: { parent_user_id: 'owner00000000001' } });
    await expect(setUserStorageLimit(ADMIN, TARGET, 10 * GB)).rejects.toThrow(
      /Sub-users share their owner's storage limit/
    );
  });

  it('refuses a limit below what the account already stores', async () => {
    stub({ used: 9 * GB });
    await expect(setUserStorageLimit(ADMIN, TARGET, 5 * GB)).rejects.toThrow(
      /is below the 9\.0 GB this account already stores/
    );
  });

  it('accepts a limit exactly equal to current usage', async () => {
    stub({ used: 5 * GB });
    await expect(setUserStorageLimit(ADMIN, TARGET, 5 * GB)).resolves.not.toThrow();
  });

  it('counts usage across the whole account, owner plus sub-users', async () => {
    stub({ used: 0 });
    await setUserStorageLimit(ADMIN, TARGET, 10 * GB);

    const usageQuery = clientQuery.mock.calls.find(c => String(c[0]).includes('SUM(f.size)'));
    expect(usageQuery[0]).toContain('COALESCE(o.parent_user_id, o.id) = $1');
  });

  it('skips the usage check entirely when clearing the limit', async () => {
    queueQueryResults(
      { rows: [] }, // BEGIN
      { rows: [{ first_user_id: ADMIN }] }, // verifyFirstUser
      { rows: [{ parent_user_id: null }] }, // target lookup
      { rows: [] }, // UPDATE
      { rows: [] } // COMMIT
    );

    await setUserStorageLimit(ADMIN, TARGET, null);

    expect(clientQuery.mock.calls.some(c => String(c[0]).includes('SUM(f.size)'))).toBe(false);
  });

  it('writes the limit through a parameterised update', async () => {
    stub({ used: 0 });
    await setUserStorageLimit(ADMIN, TARGET, 10 * GB);

    const update = clientQuery.mock.calls.find(c => String(c[0]).includes('UPDATE users SET storage_limit'));
    expect(update[0]).toContain('$1');
    expect(update[1]).toEqual([10 * GB, TARGET]);
  });

  it('commits on success', async () => {
    stub({ used: 0 });
    await setUserStorageLimit(ADMIN, TARGET, 10 * GB);
    expect(clientQuery.mock.calls.map(c => c[0])).toContain('COMMIT');
  });
});

describe('getMaxUploadSizeSettings', () => {
  it('returns the configured value', async () => {
    alwaysReturn({ rows: [{ max_upload_size_bytes: 5 * GB }] });
    expect(await getMaxUploadSizeSettings()).toEqual({ maxBytes: 5 * GB });
  });

  it('falls back to the default when nothing is configured', async () => {
    alwaysReturn({ rows: [] });
    expect((await getMaxUploadSizeSettings()).maxBytes).toBeGreaterThan(0);
  });

  it('falls back to the default for a null column', async () => {
    alwaysReturn({ rows: [{ max_upload_size_bytes: null }] });
    const withNull = (await getMaxUploadSizeSettings()).maxBytes;

    alwaysReturn({ rows: [] });
    expect(withNull).toBe((await getMaxUploadSizeSettings()).maxBytes);
  });

  it('ignores an out-of-range stored value rather than trusting it', async () => {
    alwaysReturn({ rows: [{ max_upload_size_bytes: 1 }] });
    const tooSmall = (await getMaxUploadSizeSettings()).maxBytes;
    expect(tooSmall).toBeGreaterThan(1);

    alwaysReturn({ rows: [{ max_upload_size_bytes: Number.MAX_SAFE_INTEGER }] });
    expect((await getMaxUploadSizeSettings()).maxBytes).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('caches the resolved settings', async () => {
    alwaysReturn({ rows: [{ max_upload_size_bytes: 5 * GB }] });
    await getMaxUploadSizeSettings();
    expect(await getCache(cacheKeys.maxUploadSizeSettings())).toEqual({ maxBytes: 5 * GB });
  });

  it('serves the cached settings without querying', async () => {
    await setCache(cacheKeys.maxUploadSizeSettings(), { maxBytes: 123 });
    expect(await getMaxUploadSizeSettings()).toEqual({ maxBytes: 123 });
    expect(executedCalls()).toHaveLength(0);
  });
});

describe('getElectronOnlyAccessSettings', () => {
  it('reports true only when the column is exactly true', async () => {
    alwaysReturn({ rows: [{ require_electron_client: true }] });
    expect(await getElectronOnlyAccessSettings()).toBe(true);
  });

  it('reports false for a falsy or absent value', async () => {
    alwaysReturn({ rows: [{ require_electron_client: false }] });
    expect(await getElectronOnlyAccessSettings()).toBe(false);
  });

  it('reports false when there is no settings row', async () => {
    alwaysReturn({ rows: [] });
    expect(await getElectronOnlyAccessSettings()).toBe(false);
  });

  it('caches the result', async () => {
    alwaysReturn({ rows: [{ require_electron_client: true }] });
    await getElectronOnlyAccessSettings();
    expect(await getCache(cacheKeys.electronOnlyAccessSettings())).toBe(true);
  });
});
