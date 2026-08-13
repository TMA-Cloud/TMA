import { describe, expect, it } from 'vitest';

import { alwaysReturn } from '../../mocks/db.mock.js';
import { mockReq } from '../../helpers/http.js';
import { buildShareLink, getRequestHost, getShareBaseHost, getShareBaseUrl } from '../../../utils/shareLink.js';

/** Make the app_settings lookup return a configured share base URL (or none). */
function configureShareBaseUrl(url) {
  alwaysReturn({ rows: url === null ? [] : [{ share_base_url: url }], rowCount: url === null ? 0 : 1 });
}

describe('getShareBaseUrl', () => {
  it('uses the configured share domain when one is set', async () => {
    configureShareBaseUrl('https://share.example.com');
    expect(await getShareBaseUrl(mockReq({ headers: { host: 'cloud.example.com' } }))).toBe(
      'https://share.example.com'
    );
  });

  it('strips a path from the configured URL, keeping only the origin', async () => {
    configureShareBaseUrl('https://share.example.com/some/path');
    expect(await getShareBaseUrl(mockReq())).toBe('https://share.example.com');
  });

  it('keeps a non-default port from the configured URL', async () => {
    configureShareBaseUrl('https://share.example.com:8443');
    expect(await getShareBaseUrl(mockReq())).toBe('https://share.example.com:8443');
  });

  it('falls back to the request origin when nothing is configured', async () => {
    configureShareBaseUrl(null);
    const req = mockReq({ protocol: 'https', headers: { host: 'cloud.example.com' } });
    expect(await getShareBaseUrl(req)).toBe('https://cloud.example.com');
  });

  it('falls back to the request origin when the configured URL is unparseable', async () => {
    configureShareBaseUrl('not a url at all');
    const req = mockReq({ protocol: 'https', headers: { host: 'cloud.example.com' } });
    expect(await getShareBaseUrl(req)).toBe('https://cloud.example.com');
  });

  describe('reverse proxy headers', () => {
    it('honours X-Forwarded-Proto and X-Forwarded-Host', async () => {
      configureShareBaseUrl(null);
      const req = mockReq({
        protocol: 'http',
        headers: { host: 'internal:3000', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'cloud.example.com' },
      });
      expect(await getShareBaseUrl(req)).toBe('https://cloud.example.com');
    });

    it('takes the first entry from a proxy chain', async () => {
      configureShareBaseUrl(null);
      const req = mockReq({
        headers: {
          'x-forwarded-proto': 'https, http',
          'x-forwarded-host': 'cloud.example.com, internal.local',
        },
      });
      expect(await getShareBaseUrl(req)).toBe('https://cloud.example.com');
    });

    it('trims whitespace inside a proxy chain', async () => {
      configureShareBaseUrl(null);
      const req = mockReq({
        headers: { 'x-forwarded-proto': ' https ', 'x-forwarded-host': ' cloud.example.com ' },
      });
      expect(await getShareBaseUrl(req)).toBe('https://cloud.example.com');
    });

    it('falls back to the request protocol when the forwarded one is empty', async () => {
      configureShareBaseUrl(null);
      const req = mockReq({
        protocol: 'https',
        headers: { host: 'cloud.example.com', 'x-forwarded-proto': ',http' },
      });
      expect(await getShareBaseUrl(req)).toBe('https://cloud.example.com');
    });
  });

  it('falls back to http://localhost when no host can be determined at all', async () => {
    configureShareBaseUrl(null);
    const req = mockReq();
    req.get = () => undefined;
    expect(await getShareBaseUrl(req)).toBe('http://localhost');
  });

  it('never leaves a trailing slash, so links do not end up with a double slash', async () => {
    configureShareBaseUrl('https://share.example.com/');
    expect(await getShareBaseUrl(mockReq())).not.toMatch(/\/$/);
  });
});

describe('buildShareLink', () => {
  it('builds a /s/<token> link on the configured domain', async () => {
    configureShareBaseUrl('https://share.example.com');
    expect(await buildShareLink('AbC123xyz789QWer', mockReq())).toBe('https://share.example.com/s/AbC123xyz789QWer');
  });

  it('builds the link against the request origin when nothing is configured', async () => {
    configureShareBaseUrl(null);
    const req = mockReq({ protocol: 'https', headers: { host: 'cloud.example.com' } });
    expect(await buildShareLink('tok1234567890abc', req)).toBe('https://cloud.example.com/s/tok1234567890abc');
  });

  it('URL-encodes the token so it cannot break out of the path segment', async () => {
    configureShareBaseUrl('https://share.example.com');
    const link = await buildShareLink('../../admin', mockReq());
    expect(link).toBe('https://share.example.com/s/..%2F..%2Fadmin');
    expect(link).not.toContain('/s/../');
  });

  it('never produces a double slash before the token', async () => {
    configureShareBaseUrl('https://share.example.com/');
    expect(await buildShareLink('tok', mockReq())).toBe('https://share.example.com/s/tok');
  });
});

describe('getRequestHost', () => {
  it('reads the Host header', () => {
    expect(getRequestHost(mockReq({ headers: { host: 'cloud.example.com' } }))).toBe('cloud.example.com');
  });

  it('prefers X-Forwarded-Host', () => {
    const req = mockReq({ headers: { host: 'internal:3000', 'x-forwarded-host': 'cloud.example.com' } });
    expect(getRequestHost(req)).toBe('cloud.example.com');
  });

  it('takes the first host from a proxy chain and trims it', () => {
    const req = mockReq({ headers: { 'x-forwarded-host': ' a.example.com , b.example.com ' } });
    expect(getRequestHost(req)).toBe('a.example.com');
  });

  it('returns undefined when there is no host at all', () => {
    const req = mockReq();
    req.get = () => undefined;
    expect(getRequestHost(req)).toBeUndefined();
  });
});

describe('getShareBaseHost', () => {
  it('returns the host of the configured share URL', async () => {
    configureShareBaseUrl('https://share.example.com');
    expect(await getShareBaseHost()).toBe('share.example.com');
  });

  it('includes the port when one is configured', async () => {
    configureShareBaseUrl('https://share.example.com:8443');
    expect(await getShareBaseHost()).toBe('share.example.com:8443');
  });

  it('returns null when nothing is configured', async () => {
    configureShareBaseUrl(null);
    expect(await getShareBaseHost()).toBeNull();
  });

  it('returns null when the stored value is empty', async () => {
    configureShareBaseUrl('');
    expect(await getShareBaseHost()).toBeNull();
  });

  it('returns null for an invalid stored URL', async () => {
    configureShareBaseUrl('::::not-a-url');
    expect(await getShareBaseHost()).toBeNull();
  });
});
