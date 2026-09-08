import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    if (/^(R2_|RUSTFS_|AWS_)/.test(key)) vi.stubEnv(key, '');
  }
});
afterEach(() => vi.unstubAllEnvs());

describe('required bucket configuration', () => {
  it('fails when no bucket is configured', async () => {
    await expect(import('../../../config/storage.js')).rejects.toThrow('S3 bucket configuration is required');
  });

  it('rejects incomplete configuration without exposing credentials', async () => {
    vi.stubEnv('RUSTFS_ENDPOINT', 'https://bucket.example.com');
    vi.stubEnv('RUSTFS_BUCKET', 'files');
    vi.stubEnv('RUSTFS_ACCESS_KEY', 'private-test-access-key');
    await expect(import('../../../config/storage.js')).rejects.toThrow('S3 bucket configuration is required');
  });

  it.each([
    [
      'R2',
      { R2_ACCOUNT_ID: 'account', R2_BUCKET: 'files', R2_ACCESS_KEY_ID: 'key', R2_SECRET_ACCESS_KEY: 'secret' },
      'https://account.r2.cloudflarestorage.com',
      'auto',
      false,
    ],
    [
      'RustFS',
      {
        RUSTFS_ENDPOINT: 'https://rustfs.example.com',
        RUSTFS_BUCKET: 'files',
        RUSTFS_ACCESS_KEY: 'key',
        RUSTFS_SECRET_KEY: 'secret',
      },
      'https://rustfs.example.com',
      'us-east-1',
      true,
    ],
    [
      'AWS',
      {
        AWS_S3_ENDPOINT: 'https://s3.eu-west-1.amazonaws.com',
        AWS_S3_BUCKET: 'files',
        AWS_ACCESS_KEY_ID: 'key',
        AWS_SECRET_ACCESS_KEY: 'secret',
        AWS_REGION: 'eu-west-1',
      },
      'https://s3.eu-west-1.amazonaws.com',
      'eu-west-1',
      true,
    ],
  ])('supports %s without a driver selector', async (_provider, env, endpoint, region, forcePathStyle) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const { s3 } = await import('../../../config/storage.js');
    expect(s3).toEqual({
      endpoint,
      bucket: 'files',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      region,
      forcePathStyle,
    });
  });
});
