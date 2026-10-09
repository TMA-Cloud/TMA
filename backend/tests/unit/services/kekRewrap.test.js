import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({ fetchRewrapPage: vi.fn(), applyRewraps: vi.fn() }));
const storage = vi.hoisted(() => ({ rewrapStorageSecret: vi.fn() }));
vi.mock('../../../models/kekRewrap.model.js', () => model);
vi.mock('../../../models/user/user.admin.storage.model.js', () => storage);
vi.mock('../../../config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { rewrapToPrimaryKey } = await import('../../../services/kekRewrap.js');
const { kekForVersion, unwrapDek, wrapDek } = await import('../../../utils/fileEncryption.js');

const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

function rowUnder(version, id) {
  const dek = crypto.randomBytes(32);
  return { id, dek, dekWrapped: wrapDek(dek, kekForVersion(version)), dekKekVersion: version };
}

beforeEach(() => {
  vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}`);
  storage.rewrapStorageSecret.mockResolvedValue(false);
  model.applyRewraps.mockImplementation(async updates => updates.length);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rewrapToPrimaryKey', () => {
  it('rewraps every page under the newest key without changing the data keys', async () => {
    const rows = [rowUnder(1, 'a'), rowUnder(1, 'b'), rowUnder(1, 'c')];
    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n2:${V2}`);
    model.fetchRewrapPage
      .mockResolvedValueOnce(rows.slice(0, 2))
      .mockResolvedValueOnce(rows.slice(2))
      .mockResolvedValue([]);
    const onProgress = vi.fn();

    const result = await rewrapToPrimaryKey({ onProgress });

    expect(result).toMatchObject({ primary: 2, rewrapped: 3, failures: [] });
    // The cursor moves past each page.
    expect(model.fetchRewrapPage.mock.calls.map(call => call[1])).toEqual(['', 'b', 'c']);
    const written = model.applyRewraps.mock.calls.flatMap(([updates]) => updates);
    expect(written).toHaveLength(3);
    for (const [i, update] of written.entries()) {
      expect(update).toMatchObject({ id: rows[i].id, fromVersion: 1, kekVersion: 2 });
      expect(unwrapDek(update.dekWrapped, kekForVersion(2)).equals(rows[i].dek)).toBe(true);
    }
    expect(onProgress).toHaveBeenLastCalledWith({ rewrapped: 3, failed: 0 });
  });

  it('reports rows it cannot open and carries on with the rest', async () => {
    const good = rowUnder(1, 'a');
    vi.stubEnv('FILE_ENCRYPTION_KEY', `2:${V2}\n1:${V1}`);
    const tampered = { id: 'b', dekWrapped: crypto.randomBytes(60), dekKekVersion: 1 };
    const unknownVersion = { id: 'c', dekWrapped: crypto.randomBytes(60), dekKekVersion: 7 };
    model.fetchRewrapPage.mockResolvedValueOnce([good, tampered, unknownVersion]).mockResolvedValue([]);

    const result = await rewrapToPrimaryKey();

    expect(result.rewrapped).toBe(1);
    expect(result.failures.map(f => [f.id, f.fromVersion])).toEqual([
      ['b', 1],
      ['c', 7],
    ]);
    expect(result.failures[1].error).toMatch(/no key version 7/);
  });

  it('counts only rows the update wrote, since another run may have taken some', async () => {
    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${V1}\n2:${V2}`);
    model.fetchRewrapPage.mockResolvedValueOnce([rowUnder(1, 'a'), rowUnder(1, 'b')]).mockResolvedValue([]);
    model.applyRewraps.mockResolvedValue(1);

    expect((await rewrapToPrimaryKey()).rewrapped).toBe(1);
  });

  it('rewraps the bucket secret too', async () => {
    storage.rewrapStorageSecret.mockResolvedValue(true);
    model.fetchRewrapPage.mockResolvedValue([]);

    expect(await rewrapToPrimaryKey()).toMatchObject({ storageSecret: true, rewrapped: 0 });
  });
});
