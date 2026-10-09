import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { loadStorageConfig } = vi.hoisted(() => ({ loadStorageConfig: vi.fn() }));
vi.mock('../../../models/user/user.admin.storage.model.js', () => ({ loadStorageConfig }));

const CONFIG = { endpoint: 'https://s3.example.com', bucket: 'files', secretAccessKey: 'secret', version: 3 };

let storage;
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  loadStorageConfig.mockReset();
  storage = await import('../../../config/storage.js');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('storage configuration resolver', () => {
  it('fails with a 503 setup error when no bucket is configured', async () => {
    loadStorageConfig.mockResolvedValue(null);

    await expect(storage.getS3Config()).rejects.toMatchObject({ code: 'STORAGE_NOT_CONFIGURED', status: 503 });
    await expect(storage.getS3ConfigOrNull()).resolves.toBeNull();
  });

  it('reads the database once per TTL, however many callers arrive together', async () => {
    loadStorageConfig.mockResolvedValue(CONFIG);

    const results = await Promise.all([storage.getS3Config(), storage.getS3Config(), storage.getS3Config()]);
    await storage.getS3Config();

    expect(results).toEqual([CONFIG, CONFIG, CONFIG]);
    expect(loadStorageConfig).toHaveBeenCalledTimes(1);
  });

  it('re-reads after the TTL so other processes pick up a change', async () => {
    loadStorageConfig.mockResolvedValueOnce(CONFIG).mockResolvedValueOnce({ ...CONFIG, version: 4 });

    await storage.getS3Config();
    vi.advanceTimersByTime(16_000);

    expect((await storage.getS3Config()).version).toBe(4);
  });

  it('re-reads at once after an invalidation in this process', async () => {
    loadStorageConfig.mockResolvedValueOnce(null).mockResolvedValueOnce(CONFIG);

    await expect(storage.getS3ConfigOrNull()).resolves.toBeNull();
    storage.invalidateS3Config();

    await expect(storage.getS3Config()).resolves.toEqual(CONFIG);
  });

  it('does not cache a read that started before an invalidation', async () => {
    let finishStale;
    loadStorageConfig
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishStale = resolve;
          })
      )
      .mockResolvedValue(CONFIG);

    const stale = storage.getS3ConfigOrNull();
    storage.invalidateS3Config();
    finishStale(null);
    await stale;

    await expect(storage.getS3Config()).resolves.toEqual(CONFIG);
  });
});
