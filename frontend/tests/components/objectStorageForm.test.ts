import { describe, expect, it } from 'vitest';

import {
  EMPTY_FORM,
  formFromSummary,
  parseR2Endpoint,
  r2Endpoint,
  toStorageInput,
  validateForm,
} from '../../src/components/settings/sections/objectStorageForm';

const ACCOUNT = '0123456789abcdef0123456789abcdef';

describe('R2 endpoints', () => {
  it('builds the endpoint for each jurisdiction', () => {
    expect(r2Endpoint(ACCOUNT, 'default')).toBe(`https://${ACCOUNT}.r2.cloudflarestorage.com`);
    expect(r2Endpoint(ACCOUNT.toUpperCase(), 'eu')).toBe(`https://${ACCOUNT}.eu.r2.cloudflarestorage.com`);
  });

  it('reads the account and jurisdiction back from a saved endpoint', () => {
    expect(parseR2Endpoint(`https://${ACCOUNT}.fedramp.r2.cloudflarestorage.com`)).toEqual({
      accountId: ACCOUNT,
      jurisdiction: 'fedramp',
    });
    expect(parseR2Endpoint('https://s3.example.com')).toBeNull();
  });
});

describe('formFromSummary', () => {
  it('starts empty when nothing is configured', () => {
    expect(formFromSummary({ configured: false, version: 0 })).toEqual(EMPTY_FORM);
  });

  it('never prefills credentials, so blank means keep the saved pair', () => {
    const form = formFromSummary({
      configured: true,
      version: 2,
      provider: 'r2',
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      region: 'auto',
      bucket: 'files',
      forcePathStyle: false,
      accessKeyIdMasked: 'AKIA••••MPLE',
    });
    expect(form).toMatchObject({ provider: 'r2', accountId: ACCOUNT, region: '', bucket: 'files' });
    expect(form.accessKeyId).toBe('');
    expect(form.secretAccessKey).toBe('');
  });
});

describe('toStorageInput', () => {
  it('sends the R2 endpoint built from the account ID and trims every field', () => {
    const input = toStorageInput(
      {
        ...EMPTY_FORM,
        provider: 'r2',
        accountId: ` ${ACCOUNT} `,
        bucket: ' files ',
        accessKeyId: ' k ',
        secretAccessKey: ' s ',
      },
      4
    );
    expect(input).toMatchObject({
      endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      bucket: 'files',
      accessKeyId: 'k',
      secretAccessKey: 's',
      expectedVersion: 4,
    });
  });
});

describe('validateForm', () => {
  const s3 = { ...EMPTY_FORM, provider: 's3' as const, endpoint: 'https://s3.example.com', bucket: 'files' };

  it('asks for both keys on first setup', () => {
    expect(validateForm(s3, false)).toMatch(/access key ID and secret/);
    expect(validateForm({ ...s3, accessKeyId: 'k', secretAccessKey: 's' }, false)).toBeNull();
  });

  it('lets blank keys through once some are saved', () => {
    expect(validateForm(s3, true)).toBeNull();
  });

  it('wants the key ID that goes with a new secret', () => {
    expect(validateForm({ ...s3, secretAccessKey: 's' }, true)).toMatch(/access key ID that belongs/);
  });

  it('checks the provider-specific field', () => {
    expect(validateForm({ ...EMPTY_FORM, provider: 'r2', bucket: 'files' }, true)).toMatch(/account ID/);
    expect(validateForm({ ...EMPTY_FORM, provider: 'aws', bucket: 'files' }, true)).toMatch(/AWS region/);
    expect(validateForm({ ...s3, endpoint: '' }, true)).toMatch(/endpoint/);
  });
});
