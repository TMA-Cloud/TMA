import crypto from 'crypto';

import { describe, expect, it } from 'vitest';

import {
  GoogleAuthSettingsError,
  decryptGoogleSecret,
  encryptGoogleSecret,
  normalizeGoogleAuthSettings,
  normalizeRedirectUri,
  openGoogleSecret,
} from '../../../utils/googleAuthSettings.js';
import { kekForVersion, primaryKekVersion } from '../../../utils/fileEncryption.js';
import { openSecret, sealSecret } from '../../../utils/storageSettings.js';
import { openSettingSecret, sealSettingSecret } from '../../../utils/settingsSecret.js';

const CLIENT_ID = '123456789012-abcdefghijklmnop0123456789abcdef.apps.googleusercontent.com';
const valid = {
  clientId: CLIENT_ID,
  clientSecret: 'GOCSPX-abcdefghijklmnopqrstuvwxyz12',
  redirectUri: 'https://cloud.example.com/api/google/callback',
};

describe('normalizeRedirectUri', () => {
  it('keeps the origin and the callback path', () => {
    expect(normalizeRedirectUri(' https://Cloud.Example.com:8443/api/google/callback ')).toBe(
      'https://cloud.example.com:8443/api/google/callback'
    );
  });

  it('allows plain http only on localhost, as Google does', () => {
    expect(normalizeRedirectUri('http://localhost:3000/api/google/callback')).toBe(
      'http://localhost:3000/api/google/callback'
    );
    expect(normalizeRedirectUri('http://127.0.0.1/api/google/callback')).toBe('http://127.0.0.1/api/google/callback');
    expect(() => normalizeRedirectUri('http://cloud.example.com/api/google/callback')).toThrow(/https/);
  });

  it.each([
    ['', /required/],
    ['not a url', /full URL/],
    ['ftp://cloud.example.com/api/google/callback', /https/],
    ['https://user:pw@cloud.example.com/api/google/callback', /credentials/],
    ['https://cloud.example.com/api/google/callback?next=/evil', /query/],
    ['https://cloud.example.com/api/google/callback#x', /fragment/],
    ['https://203.0.113.5/api/google/callback', /IP address/],
    ['https://cloud/api/google/callback', /public domain/],
    ['https://cloud.example.com/api/google/other', /must end with/],
    ['https://cloud.example.com/', /must end with/],
    [`https://cloud.example.com/${'a'.repeat(2048)}`, /too long/],
  ])('rejects %j', (value, message) => {
    expect(() => normalizeRedirectUri(value)).toThrow(message);
  });
});

describe('normalizeGoogleAuthSettings', () => {
  it('accepts a full client', () => {
    expect(normalizeGoogleAuthSettings(valid)).toEqual(valid);
  });

  it.each([
    [{ ...valid, clientId: '' }, /Client ID is required/],
    [{ ...valid, clientId: 'my-app' }, /must look like/],
    [{ ...valid, clientSecret: 'short' }, /not valid/],
    [{ ...valid, clientSecret: 'has spaces inside it' }, /not valid/],
    [{ ...valid, clientSecret: '' }, /secret is required/],
  ])('rejects %j', (input, message) => {
    expect(() => normalizeGoogleAuthSettings(input)).toThrow(GoogleAuthSettingsError);
    expect(() => normalizeGoogleAuthSettings(input)).toThrow(message);
  });

  it('keeps the saved secret when it is left blank for the same client', () => {
    const current = { clientId: CLIENT_ID, clientSecret: 'GOCSPX-saved-secret-value' };
    const next = normalizeGoogleAuthSettings(
      { ...valid, clientSecret: '', redirectUri: 'https://new.example.com/api/google/callback' },
      current
    );
    expect(next.clientSecret).toBe('GOCSPX-saved-secret-value');
    expect(next.redirectUri).toBe('https://new.example.com/api/google/callback');
  });

  it('requires a new secret when the client ID changes', () => {
    const current = { clientId: '999-zzz.apps.googleusercontent.com', clientSecret: 'GOCSPX-other-client' };
    expect(() => normalizeGoogleAuthSettings({ ...valid, clientSecret: '' }, current)).toThrow(/secret is required/);
  });
});

describe('client secret at rest', () => {
  it('round-trips under the primary key', () => {
    const { encrypted, kekVersion } = encryptGoogleSecret(valid.clientSecret, CLIENT_ID);
    expect(Buffer.from(encrypted).toString('utf8')).not.toContain('GOCSPX');
    expect(decryptGoogleSecret(encrypted, CLIENT_ID, kekVersion)).toBe(valid.clientSecret);
  });

  it('will not open under another client ID', () => {
    const { encrypted, kekVersion } = encryptGoogleSecret(valid.clientSecret, CLIENT_ID);
    expect(() => decryptGoogleSecret(encrypted, '1-other.apps.googleusercontent.com', kekVersion)).toThrow();
  });

  it('cannot be opened as a bucket secret, or a bucket secret as a Google one', () => {
    const kek = kekForVersion(primaryKekVersion());
    const google = encryptGoogleSecret(valid.clientSecret, 'same-binding');
    const bucket = sealSecret('bucket-secret', 'same-binding', kek);
    expect(() => openSecret(google.encrypted, 'same-binding', kek)).toThrow();
    expect(() => openGoogleSecret(bucket, 'same-binding', kek)).toThrow();
  });
});

describe('sealSettingSecret', () => {
  const purpose = { keyInfo: 'test/v1', aadPrefix: 'test', label: 'test secret' };
  const kek = crypto.randomBytes(32);

  it('uses a fresh IV each time', () => {
    const a = sealSettingSecret('s3cret', purpose, 'id', kek);
    const b = sealSettingSecret('s3cret', purpose, 'id', kek);
    expect(a.equals(b)).toBe(false);
    expect(openSettingSecret(a, purpose, 'id', kek)).toBe('s3cret');
  });

  it('rejects a tampered or truncated blob', () => {
    const sealed = sealSettingSecret('s3cret', purpose, 'id', kek);
    const tampered = Buffer.from(sealed);
    tampered[tampered.length - 1] ^= 1;
    expect(() => openSettingSecret(tampered, purpose, 'id', kek)).toThrow();
    expect(() => openSettingSecret(sealed.subarray(0, 10), purpose, 'id', kek)).toThrow(/unknown format/);
  });
});
