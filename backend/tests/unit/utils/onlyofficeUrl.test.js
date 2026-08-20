import { describe, expect, it } from 'vitest';

import { normalizeOnlyOfficeUrl, normalizeOnlyOfficeUrlSafe } from '../../../utils/onlyofficeUrl.js';

describe('normalizeOnlyOfficeUrl', () => {
  it('prepends http:// to a bare host', () => {
    expect(normalizeOnlyOfficeUrl('192.168.1.1')).toBe('http://192.168.1.1');
  });

  it('prepends http:// to a bare host with a port', () => {
    expect(normalizeOnlyOfficeUrl('192.168.1.1:8080')).toBe('http://192.168.1.1:8080');
  });

  it('preserves an explicit https scheme', () => {
    expect(normalizeOnlyOfficeUrl('https://oo.example.com')).toBe('https://oo.example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeOnlyOfficeUrl('  http://ds.local  ')).toBe('http://ds.local');
  });

  it('strips a trailing slash', () => {
    expect(normalizeOnlyOfficeUrl('https://oo.example.com/')).toBe('https://oo.example.com');
  });

  it('preserves a reverse-proxy subpath without a trailing slash', () => {
    expect(normalizeOnlyOfficeUrl('https://example.com/onlyoffice/')).toBe('https://example.com/onlyoffice');
  });

  it('drops a hash fragment', () => {
    expect(normalizeOnlyOfficeUrl('https://ds.local/#/foo')).toBe('https://ds.local');
  });

  it('rejects an empty string', () => {
    expect(() => normalizeOnlyOfficeUrl('   ')).toThrow(/must not be empty/);
  });

  it('rejects a non-http(s) scheme', () => {
    expect(() => normalizeOnlyOfficeUrl('ftp://ds.local')).toThrow(/http or https/);
  });

  it('rejects a non-string value', () => {
    expect(() => normalizeOnlyOfficeUrl(null)).toThrow(/must be a string/);
  });
});

describe('normalizeOnlyOfficeUrlSafe', () => {
  it('normalizes a repairable value', () => {
    expect(normalizeOnlyOfficeUrlSafe('192.168.1.1')).toBe('http://192.168.1.1');
  });

  it('returns null unchanged', () => {
    expect(normalizeOnlyOfficeUrlSafe(null)).toBeNull();
  });

  it('returns an unparseable value unchanged rather than throwing', () => {
    // A space makes the host invalid; the read path must not crash on legacy data.
    expect(normalizeOnlyOfficeUrlSafe('http://bad host')).toBe('http://bad host');
  });
});
