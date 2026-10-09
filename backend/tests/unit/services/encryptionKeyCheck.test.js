import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const model = vi.hoisted(() => ({
  getKekChecks: vi.fn(),
  recordKekCheck: vi.fn(),
  sampleSealedUnderVersion: vi.fn(),
  kekVersionsInUse: vi.fn(),
}));
vi.mock('../../../models/kekCheck.model.js', () => model);
vi.mock('../../../config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { verifyEncryptionKeys, verifyEncryptionKeysWhenReady } = await import('../../../services/encryptionKeyCheck.js');
const { getEncryptionKey, wrapDek } = await import('../../../utils/fileEncryption.js');
const { kekCheckValue } = await import('../../../utils/fileEncryption/keyCheck.js');

const otherKey = crypto.randomBytes(32);

beforeEach(() => {
  model.getKekChecks.mockResolvedValue(new Map());
  model.recordKekCheck.mockImplementation(async (_version, value) => value);
  model.sampleSealedUnderVersion.mockResolvedValue({ dekWrapped: null, storageSecret: null });
  model.kekVersionsInUse.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifyEncryptionKeys', () => {
  it('passes when the stored check matches', async () => {
    model.getKekChecks.mockResolvedValue(new Map([[1, kekCheckValue(getEncryptionKey())]]));

    await expect(verifyEncryptionKeys()).resolves.toBeUndefined();
    expect(model.recordKekCheck).not.toHaveBeenCalled();
  });

  it('refuses to start with a key that does not match the stored check', async () => {
    model.getKekChecks.mockResolvedValue(new Map([[1, kekCheckValue(otherKey)]]));

    await expect(verifyEncryptionKeys()).rejects.toThrow(/FILE_ENCRYPTION_KEY \(key version 1\) does not match/);
  });

  it('records a check on first start once the key opens existing data', async () => {
    model.sampleSealedUnderVersion.mockResolvedValue({
      dekWrapped: wrapDek(crypto.randomBytes(32), getEncryptionKey()),
      storageSecret: null,
    });

    await verifyEncryptionKeys();

    expect(model.recordKekCheck).toHaveBeenCalledWith(1, kekCheckValue(getEncryptionKey()));
  });

  it('refuses to adopt a key that cannot open existing data', async () => {
    model.sampleSealedUnderVersion.mockResolvedValue({
      dekWrapped: wrapDek(crypto.randomBytes(32), otherKey),
      storageSecret: null,
    });

    await expect(verifyEncryptionKeys()).rejects.toThrow(/does not match/);
    expect(model.recordKekCheck).not.toHaveBeenCalled();
  });

  it('checks older keys in the keyring too, naming the wrong version', async () => {
    vi.stubEnv('FILE_ENCRYPTION_KEY', `1:${'ef'.repeat(32)},2:${'cd'.repeat(32)}`);
    model.getKekChecks.mockResolvedValue(new Map([[1, kekCheckValue(otherKey)]]));

    await expect(verifyEncryptionKeys()).rejects.toThrow(/key version 1\) does not match/);
  });

  it('refuses a passphrase as the newest key in production, unless a key is being added on top', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FILE_ENCRYPTION_KEY', 'an old passphrase');

    await expect(verifyEncryptionKeys()).rejects.toThrow(/must be a random 32-byte key/);
    await expect(verifyEncryptionKeys({ allowPassphrasePrimary: true })).resolves.toBeUndefined();
  });

  it('refuses to start when stored data uses a version the keyring lacks', async () => {
    model.kekVersionsInUse.mockResolvedValue([1, 2]);

    await expect(verifyEncryptionKeys()).rejects.toThrow(/key version 2, which FILE_ENCRYPTION_KEY does not contain/);
    expect(model.recordKekCheck).not.toHaveBeenCalled();
  });

  it('fails if another process recorded a different key first', async () => {
    model.recordKekCheck.mockResolvedValue(kekCheckValue(otherKey));

    await expect(verifyEncryptionKeys()).rejects.toThrow(/does not match/);
  });
});

describe('verifyEncryptionKeysWhenReady', () => {
  const missingTable = Object.assign(new Error('relation "kek_checks" does not exist'), { code: '42P01' });

  it('waits for the API to create the check table, then checks', async () => {
    model.getKekChecks.mockRejectedValueOnce(missingTable).mockRejectedValueOnce(missingTable);
    model.getKekChecks.mockResolvedValue(new Map([[1, kekCheckValue(getEncryptionKey())]]));

    await verifyEncryptionKeysWhenReady({ attempts: 5, delayMs: 1 });

    expect(model.getKekChecks).toHaveBeenCalledTimes(3);
  });

  it('still refuses a wrong key once the table exists', async () => {
    model.getKekChecks.mockRejectedValueOnce(missingTable);
    model.getKekChecks.mockResolvedValue(new Map([[1, kekCheckValue(otherKey)]]));

    await expect(verifyEncryptionKeysWhenReady({ attempts: 5, delayMs: 1 })).rejects.toThrow(/does not match/);
  });

  it('gives up waiting without failing, since the API performs the check', async () => {
    model.getKekChecks.mockRejectedValue(missingTable);

    await expect(verifyEncryptionKeysWhenReady({ attempts: 2, delayMs: 1 })).resolves.toBeUndefined();
  });
});
