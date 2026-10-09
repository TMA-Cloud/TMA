import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  decryptStorageSecret,
  encryptStorageSecret,
  maskAccessKeyId,
  normalizeEndpoint,
  normalizeStorageSettings,
  openSecret,
  sameStorageTarget,
  sealSecret,
} from '../../../utils/storageSettings.js';

const base = {
  provider: 's3',
  endpoint: 'https://s3.example.com',
  bucket: 'tma-files',
  accessKeyId: 'AKIAEXAMPLE1234',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

describe('normalizeEndpoint', () => {
  it('reduces a URL to its origin', () => {
    expect(normalizeEndpoint(' https://S3.Example.com:9443/ ')).toBe('https://s3.example.com:9443');
  });

  it.each([
    ['ftp://s3.example.com', 'https:// or http://'],
    ['https://user:pass@s3.example.com', 'credentials'],
    ['https://s3.example.com/bucket', 'path'],
    ['https://s3.example.com/?x=1', 'query'],
    ['not a url', 'valid URL'],
    ['', 'required'],
  ])('rejects %s', (input, message) => {
    expect(() => normalizeEndpoint(input)).toThrow(message);
  });

  it.each([
    'http://10.1.2.103:9001',
    'http://192.168.1.5',
    'http://rustfs:9000',
    'http://minio.internal',
    'http://[::1]:9000',
  ])('allows plain http on a private network: %s', input => {
    expect(normalizeEndpoint(input)).toBe(new URL(input).origin);
  });

  it('requires https for a public endpoint', () => {
    expect(() => normalizeEndpoint('http://s3.example.com')).toThrow('Plain http://');
  });

  it.each(['http://169.254.169.254', 'https://169.254.169.254', 'https://0.0.0.0', 'https://[fe80::1]'])(
    'refuses reserved addresses such as instance metadata: %s',
    input => {
      expect(() => normalizeEndpoint(input)).toThrow('reserved');
    }
  );
});

describe('normalizeStorageSettings', () => {
  it('defaults S3-compatible stores to path-style and us-east-1', () => {
    expect(normalizeStorageSettings(base)).toEqual({
      provider: 's3',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'tma-files',
      forcePathStyle: true,
      accessKeyId: base.accessKeyId,
      secretAccessKey: base.secretAccessKey,
    });
  });

  it('forces R2 to region auto and virtual-hosted addressing', () => {
    const r2 = normalizeStorageSettings({
      ...base,
      provider: 'r2',
      endpoint: 'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com',
      region: 'eu-west-1',
      forcePathStyle: true,
    });
    expect(r2).toMatchObject({ region: 'auto', forcePathStyle: false });
  });

  it('derives the AWS endpoint from the region', () => {
    const aws = normalizeStorageSettings({ ...base, provider: 'aws', endpoint: '', region: 'eu-west-1' });
    expect(aws).toMatchObject({ endpoint: 'https://s3.eu-west-1.amazonaws.com', forcePathStyle: false });
  });

  it('requires a real AWS region', () => {
    expect(() => normalizeStorageSettings({ ...base, provider: 'aws', region: 'auto' })).toThrow('AWS region');
  });

  it.each(['ab', 'Tma-Files', 'tma..files', '-tma', '192.168.1.1', 'xn--tma', 'tma-s3alias', 'tma_files'])(
    'rejects the bucket name %s',
    bucket => {
      expect(() => normalizeStorageSettings({ ...base, bucket })).toThrow('Bucket name');
    }
  );

  it('rejects an unknown provider', () => {
    expect(() => normalizeStorageSettings({ ...base, provider: 'gcs' })).toThrow('Provider');
  });

  it('rejects credentials containing whitespace', () => {
    expect(() => normalizeStorageSettings({ ...base, secretAccessKey: 'has space' })).toThrow('not valid');
  });

  describe('credentials', () => {
    const current = { accessKeyId: 'SAVEDKEY12345', secretAccessKey: 'saved-secret' };

    it('keeps the saved pair when both are left blank', () => {
      const result = normalizeStorageSettings({ ...base, accessKeyId: '', secretAccessKey: undefined }, current);
      expect(result).toMatchObject(current);
    });

    it('keeps the saved secret when the same key ID is re-entered', () => {
      const result = normalizeStorageSettings(
        { ...base, accessKeyId: current.accessKeyId, secretAccessKey: '' },
        current
      );
      expect(result.secretAccessKey).toBe('saved-secret');
    });

    it('requires a secret for a new key ID', () => {
      expect(() => normalizeStorageSettings({ ...base, secretAccessKey: '' }, current)).toThrow(
        'Secret access key is required'
      );
    });

    it('requires both on first setup', () => {
      expect(() => normalizeStorageSettings({ ...base, accessKeyId: '', secretAccessKey: '' })).toThrow(
        'Access key ID is required'
      );
    });
  });
});

describe('secret encryption', () => {
  const kek = crypto.randomBytes(32);

  it('round-trips and never stores the plaintext', () => {
    const sealed = sealSecret(base.secretAccessKey, base.accessKeyId, kek);
    expect(sealed.includes(Buffer.from(base.secretAccessKey))).toBe(false);
    expect(openSecret(sealed, base.accessKeyId, kek)).toBe(base.secretAccessKey);
  });

  it('uses a fresh nonce each time', () => {
    const a = sealSecret('same', 'KEY', kek);
    const b = sealSecret('same', 'KEY', kek);
    expect(a.equals(b)).toBe(false);
  });

  it('fails under the wrong KEK', () => {
    const sealed = sealSecret('secret', 'KEY', kek);
    expect(() => openSecret(sealed, 'KEY', crypto.randomBytes(32))).toThrow();
  });

  it('is bound to its access key ID', () => {
    const sealed = sealSecret('secret', 'KEY-A', kek);
    expect(() => openSecret(sealed, 'KEY-B', kek)).toThrow();
  });

  it('detects tampering', () => {
    const sealed = sealSecret('secret', 'KEY', kek);
    sealed[sealed.length - 20] ^= 0xff;
    expect(() => openSecret(sealed, 'KEY', kek)).toThrow();
  });

  it('rejects an unknown format', () => {
    const sealed = sealSecret('secret', 'KEY', kek);
    sealed[0] = 9;
    expect(() => openSecret(sealed, 'KEY', kek)).toThrow('unknown format');
  });

  it('encrypts under the primary KEK version from the environment', () => {
    const { encrypted, kekVersion } = encryptStorageSecret('env-secret', 'KEY');
    expect(kekVersion).toBe(1);
    expect(decryptStorageSecret(encrypted, 'KEY', kekVersion)).toBe('env-secret');
  });
});

describe('helpers', () => {
  it('masks the access key ID', () => {
    expect(maskAccessKeyId('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA••••MPLE');
    expect(maskAccessKeyId('short')).toBe('••••');
    expect(maskAccessKeyId(null)).toBeNull();
  });

  it('compares targets by endpoint and bucket only', () => {
    const a = { endpoint: 'https://a', bucket: 'b', region: 'x' };
    expect(sameStorageTarget(a, { ...a, region: 'y' })).toBe(true);
    expect(sameStorageTarget(a, { ...a, bucket: 'c' })).toBe(false);
    expect(sameStorageTarget(a, null)).toBe(false);
  });
});
