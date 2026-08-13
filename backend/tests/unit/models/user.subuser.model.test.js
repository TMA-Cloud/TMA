import { describe, expect, it } from 'vitest';

import { alwaysReturn, clientQuery, connect, executedCalls, queueQueryResults, query } from '../../mocks/db.mock.js';
import { cacheKeys, getCache, setCache } from '../../../utils/cache.js';
import { PERMISSIONS } from '../../../utils/permissions.js';
import {
  countSubUsers,
  createSubUser,
  deleteSubUser,
  getAccountContext,
  getSubUser,
  listSubUsers,
  updateSubUserPermissions,
} from '../../../models/user/user.subuser.model.js';

const OWNER = 'owner00000000001';
const SUB = 'sub00000000000001';

describe('getAccountContext', () => {
  it('resolves an owner to itself with no permission list', async () => {
    alwaysReturn({ rows: [{ id: OWNER, parent_user_id: null, permissions: null }] });

    expect(await getAccountContext(OWNER)).toEqual({
      id: OWNER,
      ownerId: OWNER,
      permissions: [],
      isSubUser: false,
    });
  });

  it('points a sub-user at its owner and carries its grants', async () => {
    alwaysReturn({
      rows: [{ id: SUB, parent_user_id: OWNER, permissions: [PERMISSIONS.DOWNLOAD, PERMISSIONS.UPLOAD] }],
    });

    expect(await getAccountContext(SUB)).toEqual({
      id: SUB,
      ownerId: OWNER,
      permissions: [PERMISSIONS.DOWNLOAD, PERMISSIONS.UPLOAD],
      isSubUser: true,
    });
  });

  it('normalises stored grants, dropping keys that are no longer in the catalog', async () => {
    alwaysReturn({
      rows: [{ id: SUB, parent_user_id: OWNER, permissions: ['files.retired_capability', PERMISSIONS.DOWNLOAD] }],
    });

    expect((await getAccountContext(SUB)).permissions).toEqual([PERMISSIONS.DOWNLOAD]);
  });

  it('leaves an owner with an empty list even when the column holds values', async () => {
    // Owners are never checked against the list, so it stays empty by design.
    alwaysReturn({ rows: [{ id: OWNER, parent_user_id: null, permissions: [PERMISSIONS.DOWNLOAD] }] });
    expect((await getAccountContext(OWNER)).permissions).toEqual([]);
  });

  it('returns null for an unknown user', async () => {
    alwaysReturn({ rows: [] });
    expect(await getAccountContext('nobody')).toBeNull();
  });

  it('does not cache a miss, so a newly created account resolves immediately', async () => {
    alwaysReturn({ rows: [] });
    await getAccountContext('nobody');
    expect(await getCache(cacheKeys.userAccount('nobody'))).toBeNull();
  });

  it('caches the resolved context', async () => {
    alwaysReturn({ rows: [{ id: SUB, parent_user_id: OWNER, permissions: [] }] });
    await getAccountContext(SUB);
    expect(await getCache(cacheKeys.userAccount(SUB))).toMatchObject({ ownerId: OWNER, isSubUser: true });
  });

  it('serves a cached context without querying', async () => {
    await setCache(cacheKeys.userAccount(SUB), { id: SUB, ownerId: OWNER, permissions: [], isSubUser: true });
    await getAccountContext(SUB);
    expect(executedCalls()).toHaveLength(0);
  });
});

describe('listSubUsers', () => {
  it("returns the owner's sub-users", async () => {
    alwaysReturn({ rows: [{ id: SUB, email: 'a@b.com' }] });
    expect(await listSubUsers(OWNER)).toHaveLength(1);
  });

  it('scopes the query to the owner and orders oldest first', async () => {
    alwaysReturn({ rows: [] });
    await listSubUsers(OWNER);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('parent_user_id = $1');
    expect(sql).toContain('ORDER BY created_at ASC');
    expect(params).toEqual([OWNER]);
  });

  it('never selects the password column', async () => {
    alwaysReturn({ rows: [] });
    await listSubUsers(OWNER);
    expect(executedCalls()[0].sql).not.toMatch(/\bpassword\b/);
  });
});

describe('getSubUser', () => {
  it("scopes the lookup to the owner, so one account cannot read another's members", async () => {
    alwaysReturn({ rows: [] });
    await getSubUser(OWNER, SUB);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('id = $1 AND parent_user_id = $2');
    expect(params).toEqual([SUB, OWNER]);
  });

  it('returns undefined when the sub-user belongs to a different owner', async () => {
    alwaysReturn({ rows: [] });
    expect(await getSubUser(OWNER, SUB)).toBeUndefined();
  });
});

describe('createSubUser', () => {
  const validArgs = {
    ownerId: OWNER,
    email: 'sub@example.com',
    hashedPassword: '$2b$10$hash',
    name: 'Sub User',
    permissions: [PERMISSIONS.DOWNLOAD],
  };

  /** Queue the parent lookup and the insert that createSubUser performs. */
  function stubTransaction({ parentRow, inserted }) {
    queueQueryResults(
      { rows: [] }, // BEGIN
      { rows: parentRow ? [parentRow] : [] }, // SELECT ... FOR UPDATE
      { rows: inserted ? [inserted] : [] }, // INSERT ... RETURNING
      { rows: [] } // COMMIT
    );
  }

  it('inserts the sub-user under the owner', async () => {
    stubTransaction({
      parentRow: { id: OWNER, parent_user_id: null },
      inserted: { id: SUB, email: 'sub@example.com', name: 'Sub User', permissions: [PERMISSIONS.DOWNLOAD] },
    });

    const created = await createSubUser(validArgs);

    expect(created.id).toBe(SUB);
    expect(connect).toHaveBeenCalled();
  });

  it('runs inside a transaction', async () => {
    stubTransaction({ parentRow: { id: OWNER, parent_user_id: null }, inserted: { id: SUB } });
    await createSubUser(validArgs);

    const statements = clientQuery.mock.calls.map(c => c[0]);
    expect(statements[0]).toBe('BEGIN');
    expect(statements).toContain('COMMIT');
  });

  it('locks the parent row so a concurrent request cannot demote it mid-insert', async () => {
    stubTransaction({ parentRow: { id: OWNER, parent_user_id: null }, inserted: { id: SUB } });
    await createSubUser(validArgs);

    expect(clientQuery.mock.calls.map(c => c[0]).join('\n')).toContain('FOR UPDATE');
  });

  it('refuses when the parent is itself a sub-user', async () => {
    stubTransaction({ parentRow: { id: OWNER, parent_user_id: 'grandparent00001' } });
    await expect(createSubUser(validArgs)).rejects.toThrow('Sub-users cannot create sub-users');
  });

  it('refuses when the owner does not exist', async () => {
    stubTransaction({ parentRow: null });
    await expect(createSubUser(validArgs)).rejects.toThrow('Owner account not found');
  });

  it('rolls back when the insert fails', async () => {
    queueQueryResults({ rows: [] }, { rows: [{ id: OWNER, parent_user_id: null }] }, new Error('unique violation'));

    await expect(createSubUser(validArgs)).rejects.toThrow('unique violation');
    expect(clientQuery.mock.calls.map(c => c[0])).toContain('ROLLBACK');
  });

  it('always releases the client, even on failure', async () => {
    stubTransaction({ parentRow: null });
    await expect(createSubUser(validArgs)).rejects.toThrow();

    const release = (await connect.mock.results[0].value).release;
    expect(release).toHaveBeenCalled();
  });

  describe('validation before any database work', () => {
    it('rejects an unknown permission key', async () => {
      await expect(createSubUser({ ...validArgs, permissions: ['files.admin'] })).rejects.toThrow(
        'Invalid sub-user permissions'
      );
      expect(connect).not.toHaveBeenCalled();
    });

    it('rejects a non-array permission list', async () => {
      await expect(createSubUser({ ...validArgs, permissions: 'files.download' })).rejects.toThrow(
        'Invalid sub-user permissions'
      );
    });

    it('requires a non-empty name', async () => {
      await expect(createSubUser({ ...validArgs, name: '   ' })).rejects.toThrow('Sub-user name is required');
      await expect(createSubUser({ ...validArgs, name: null })).rejects.toThrow('Sub-user name is required');
    });
  });

  it('trims the display name before storing it', async () => {
    stubTransaction({ parentRow: { id: OWNER, parent_user_id: null }, inserted: { id: SUB } });
    await createSubUser({ ...validArgs, name: '  Sub User  ' });

    const insert = clientQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO users'));
    expect(insert[1][3]).toBe('Sub User');
  });

  it('stores permissions in catalog order, deduplicated', async () => {
    stubTransaction({ parentRow: { id: OWNER, parent_user_id: null }, inserted: { id: SUB } });
    await createSubUser({
      ...validArgs,
      permissions: [PERMISSIONS.TRASH, PERMISSIONS.DOWNLOAD, PERMISSIONS.DOWNLOAD],
    });

    const insert = clientQuery.mock.calls.find(c => String(c[0]).includes('INSERT INTO users'));
    expect(insert[1][5]).toEqual([PERMISSIONS.DOWNLOAD, PERMISSIONS.TRASH]);
  });

  it('accepts an empty grant list, producing a browse-only member', async () => {
    stubTransaction({ parentRow: { id: OWNER, parent_user_id: null }, inserted: { id: SUB, permissions: [] } });
    await expect(createSubUser({ ...validArgs, permissions: [] })).resolves.toBeDefined();
  });

  it('drops the cached sub-user list and user counters', async () => {
    await setCache(cacheKeys.subUsers(OWNER), ['stale']);
    await setCache(cacheKeys.userCount(), 1);
    await setCache(cacheKeys.allUsers(), ['stale']);
    await setCache(cacheKeys.signupEnabled(), true);

    stubTransaction({ parentRow: { id: OWNER, parent_user_id: null }, inserted: { id: SUB } });
    await createSubUser(validArgs);

    expect(await getCache(cacheKeys.subUsers(OWNER))).toBeNull();
    expect(await getCache(cacheKeys.userCount())).toBeNull();
    expect(await getCache(cacheKeys.allUsers())).toBeNull();
    expect(await getCache(cacheKeys.signupEnabled())).toBeNull();
  });
});

describe('updateSubUserPermissions', () => {
  it('replaces the grants and returns the updated row', async () => {
    alwaysReturn({ rows: [{ id: SUB, email: 'a@b.com', permissions: [PERMISSIONS.EDIT] }] });
    const updated = await updateSubUserPermissions(OWNER, SUB, [PERMISSIONS.EDIT]);
    expect(updated.permissions).toEqual([PERMISSIONS.EDIT]);
  });

  it('scopes the update to the owner', async () => {
    alwaysReturn({ rows: [{ id: SUB }] });
    await updateSubUserPermissions(OWNER, SUB, []);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('WHERE id = $2 AND parent_user_id = $3');
    expect(params[1]).toBe(SUB);
    expect(params[2]).toBe(OWNER);
  });

  it('normalises the grants before writing them', async () => {
    alwaysReturn({ rows: [{ id: SUB }] });
    await updateSubUserPermissions(OWNER, SUB, [PERMISSIONS.TRASH, PERMISSIONS.DOWNLOAD]);
    expect(executedCalls()[0].params[0]).toEqual([PERMISSIONS.DOWNLOAD, PERMISSIONS.TRASH]);
  });

  it('rejects an unknown permission key without touching the database', async () => {
    await expect(updateSubUserPermissions(OWNER, SUB, ['files.admin'])).rejects.toThrow('Invalid sub-user permissions');
    expect(query).not.toHaveBeenCalled();
  });

  it('drops the cached account context, so a revoked capability stops working at once', async () => {
    await setCache(cacheKeys.userAccount(SUB), { permissions: [PERMISSIONS.DELETE] });
    alwaysReturn({ rows: [{ id: SUB }] });

    await updateSubUserPermissions(OWNER, SUB, []);

    expect(await getCache(cacheKeys.userAccount(SUB))).toBeNull();
  });

  it('returns undefined and leaves caches alone when nothing matched', async () => {
    await setCache(cacheKeys.userAccount(SUB), { permissions: [PERMISSIONS.DELETE] });
    alwaysReturn({ rows: [] });

    expect(await updateSubUserPermissions(OWNER, SUB, [])).toBeUndefined();
    expect(await getCache(cacheKeys.userAccount(SUB))).not.toBeNull();
  });
});

describe('deleteSubUser', () => {
  it('deletes only within the owner account', async () => {
    alwaysReturn({ rows: [{ id: SUB, email: 'a@b.com' }] });
    await deleteSubUser(OWNER, SUB);
    const { sql, params } = executedCalls()[0];
    expect(sql).toContain('WHERE id = $1 AND parent_user_id = $2');
    expect(params).toEqual([SUB, OWNER]);
  });

  it('returns the deleted row', async () => {
    alwaysReturn({ rows: [{ id: SUB, email: 'a@b.com', permissions: [] }] });
    expect(await deleteSubUser(OWNER, SUB)).toMatchObject({ id: SUB });
  });

  it('returns undefined when nothing matched', async () => {
    alwaysReturn({ rows: [] });
    expect(await deleteSubUser(OWNER, SUB)).toBeUndefined();
  });

  it("clears the deleted identity's caches", async () => {
    await setCache(`user:${SUB}:id`, { id: SUB });
    await setCache(cacheKeys.subUsers(OWNER), ['stale']);
    alwaysReturn({ rows: [{ id: SUB, email: 'a@b.com' }] });

    await deleteSubUser(OWNER, SUB);

    expect(await getCache(`user:${SUB}:id`)).toBeNull();
    expect(await getCache(cacheKeys.subUsers(OWNER))).toBeNull();
  });

  it('clears the email lookup so the address can be reused', async () => {
    const emailKey = cacheKeys.userByEmail('a@b.com');
    await setCache(emailKey, { id: SUB });
    alwaysReturn({ rows: [{ id: SUB, email: 'a@b.com' }] });

    await deleteSubUser(OWNER, SUB);

    expect(await getCache(emailKey)).toBeNull();
  });
});

describe('countSubUsers', () => {
  it('returns the count', async () => {
    alwaysReturn({ rows: [{ count: 3 }] });
    expect(await countSubUsers(OWNER)).toBe(3);
  });

  it('returns zero when the query yields nothing', async () => {
    alwaysReturn({ rows: [] });
    expect(await countSubUsers(OWNER)).toBe(0);
  });

  it('returns zero rather than null for an owner with no sub-users', async () => {
    alwaysReturn({ rows: [{ count: 0 }] });
    expect(await countSubUsers(OWNER)).toBe(0);
  });
});
