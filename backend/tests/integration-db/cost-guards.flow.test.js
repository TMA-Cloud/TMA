import { beforeEach, describe, expect, it } from 'vitest';

import pool from '../../config/db.js';
import { createFileFromStreamedUpload } from '../../models/file/file.crud.model.js';
import { getFolderTree } from '../../models/file/file.metadata.model.js';
import { copyFiles, moveFiles } from '../../models/file/file.operations.model.js';
import { getFolderContentsByShare, upsertShareRoots } from '../../models/share.model.js';
import { scanOrphans } from '../../models/file/file.orphan.model.js';
import { getAllUsersBasic } from '../../models/user/user.admin.users.model.js';
import { getUserStorageUsage } from '../../models/user/user.storage.model.js';
import { releaseStorageReservation, reserveStorage } from '../../services/storageReservations.js';

const OWNER = 'cost-owner';

async function insertUser(id, email, extra = {}) {
  await pool.query(
    `INSERT INTO users(id, email, password, name, parent_user_id, storage_limit, created_at)
     VALUES($1, $2, 'hash', $3, $4, $5, COALESCE($6, NOW()))`,
    [id, email, id, extra.parentUserId || null, extra.storageLimit ?? null, extra.createdAt || null]
  );
}

describe('cost and hierarchy guards', () => {
  beforeEach(async () => {
    await insertUser(OWNER, 'cost-owner@example.com');
  });

  it('maintains storage usage on insert, resize, and delete without SUM reads', async () => {
    await pool.query(
      "INSERT INTO files(id, name, type, size, path, user_id) VALUES('usage-file', 'a.bin', 'file', 10, 'usage-key', $1)",
      [OWNER]
    );
    expect(await getUserStorageUsage(OWNER)).toBe(10);

    await pool.query("UPDATE files SET size = 25 WHERE id = 'usage-file'");
    expect(await getUserStorageUsage(OWNER)).toBe(25);

    await pool.query("DELETE FROM files WHERE id = 'usage-file'");
    expect(await getUserStorageUsage(OWNER)).toBe(0);
  });

  it('enforces quota while holding the account row lock', async () => {
    await pool.query('UPDATE users SET storage_limit = 5 WHERE id = $1', [OWNER]);
    await expect(
      createFileFromStreamedUpload(
        {
          id: 'too-large',
          storageName: 'too-large-key',
          name: 'large.bin',
          size: 6,
          mimeType: 'application/octet-stream',
        },
        null,
        OWNER
      )
    ).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
    expect(await getUserStorageUsage(OWNER)).toBe(0);
  });

  it('reserves quota for long object operations and releases it transactionally', async () => {
    await pool.query('UPDATE users SET storage_limit = 10 WHERE id = $1', [OWNER]);
    const reservation = await reserveStorage(OWNER, 7, 'test');
    const reserved = await pool.query('SELECT storage_reserved FROM users WHERE id = $1', [OWNER]);
    expect(Number(reserved.rows[0].storage_reserved)).toBe(7);
    await expect(reserveStorage(OWNER, 4, 'test')).rejects.toMatchObject({ code: 'STORAGE_LIMIT_EXCEEDED' });
    await releaseStorageReservation(reservation);
    const released = await pool.query('SELECT storage_reserved FROM users WHERE id = $1', [OWNER]);
    expect(Number(released.rows[0].storage_reserved)).toBe(0);
  });

  it('plans folder copies in a database staging table instead of application memory', async () => {
    await pool.query(
      `INSERT INTO files(id, name, type, parent_id, user_id) VALUES
       ('copy-root', 'Root', 'folder', NULL, $1),
       ('copy-child', 'Child', 'folder', 'copy-root', $1)`,
      [OWNER]
    );
    const copied = await copyFiles(['copy-root'], null, OWNER);
    expect(copied).toHaveLength(1);
    const descendants = await getFolderTree(copied[0], OWNER);
    expect(descendants.map(row => row.name).sort()).toEqual(['Child', 'Root']);
  });

  it('creates selected share subtrees in one batch and keyset-paginates their public listing', async () => {
    await pool.query(
      `INSERT INTO files(id, name, type, parent_id, user_id) VALUES
       ('share-root', 'Shared', 'folder', NULL, $1),
       ('share-a', 'A', 'folder', 'share-root', $1),
       ('share-b', 'B', 'folder', 'share-root', $1)`,
      [OWNER]
    );
    const shared = await upsertShareRoots(['share-root'], OWNER, null);
    expect(shared.counts['share-root']).toBe(3);
    const first = await getFolderContentsByShare(shared.tokens['share-root'], 'share-root', { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await getFolderContentsByShare(shared.tokens['share-root'], 'share-root', {
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toHaveLength(1);
    expect(second.items[0].id).not.toBe(first.items[0].id);
  });

  it('rejects descendant moves and bounds recursive reads over legacy cycles', async () => {
    await pool.query(
      `INSERT INTO files(id, name, type, parent_id, user_id) VALUES
       ('folder-a', 'A', 'folder', NULL, $1),
       ('folder-b', 'B', 'folder', 'folder-a', $1)`,
      [OWNER]
    );
    await expect(moveFiles(['folder-a'], 'folder-b', OWNER)).rejects.toThrow(/descendants/);

    await pool.query("UPDATE files SET parent_id = 'folder-b' WHERE id = 'folder-a'");
    const tree = await getFolderTree('folder-a', OWNER);
    expect(new Set(tree.map(row => row.id))).toEqual(new Set(['folder-a', 'folder-b']));
    expect(tree).toHaveLength(2);
  });

  it('paginates complete owner accounts and reads their counters', async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [OWNER]);
    await insertUser('owner-a', 'owner-a@example.com', { createdAt: '2025-01-01T00:00:00Z' });
    await insertUser('sub-a', 'sub-a@example.com', {
      parentUserId: 'owner-a',
      createdAt: '2025-01-01T00:00:01Z',
    });
    await insertUser('owner-b', 'owner-b@example.com', { createdAt: '2025-01-02T00:00:00Z' });
    await insertUser('owner-c', 'owner-c@example.com', { createdAt: '2025-01-03T00:00:00Z' });

    const first = await getAllUsersBasic({ limit: 2 });
    expect(first.users.map(user => user.id)).toEqual(['owner-a', 'sub-a', 'owner-b']);
    expect(first.nextCursor).toBeTruthy();
    const second = await getAllUsersBasic({ limit: 2, cursor: first.nextCursor });
    expect(second.users.map(user => user.id)).toEqual(['owner-c']);
    expect(second.nextCursor).toBeNull();
  });

  it('reconciles missing objects through a temporary inventory table', async () => {
    await pool.query(
      `INSERT INTO files(id, name, type, size, path, user_id, created_at)
       VALUES('missing-object', 'missing.bin', 'file', 12, 'missing-key', $1, NOW() - INTERVAL '2 hours')`,
      [OWNER]
    );
    const report = await scanOrphans({ graceMinutes: 60 });
    expect(report.databaseOrphans.count).toBe(1);
    expect(report.databaseOrphans.items[0].id).toBe('missing-object');
    expect(report.totals.databaseRows).toBe(1);
  });
});
