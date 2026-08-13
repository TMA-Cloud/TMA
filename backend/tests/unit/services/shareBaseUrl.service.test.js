import { describe, expect, it } from 'vitest';

import { alwaysReturn, executedCalls, query } from '../../mocks/db.mock.js';
import { cacheKeys, getCache } from '../../../utils/cache.js';
import {
  getShareBaseHost,
  getShareBaseUrlOrigin,
  getShareBaseUrlSettings,
} from '../../../services/shareBaseUrl.service.js';

function stored(url) {
  alwaysReturn({ rows: url === undefined ? [] : [{ share_base_url: url }], rowCount: url === undefined ? 0 : 1 });
}

describe('getShareBaseUrlSettings', () => {
  it('reads the configured URL from app_settings', async () => {
    stored('https://share.example.com');
    expect(await getShareBaseUrlSettings()).toEqual({ url: 'https://share.example.com' });
  });

  it('reports null when the row exists but the column is empty', async () => {
    stored(null);
    expect(await getShareBaseUrlSettings()).toEqual({ url: null });
  });

  it('reports null when there is no settings row at all', async () => {
    stored(undefined);
    expect(await getShareBaseUrlSettings()).toEqual({ url: null });
  });

  it('queries app_settings by its fixed primary key', async () => {
    stored('https://share.example.com');
    await getShareBaseUrlSettings();
    expect(executedCalls()[0].params).toEqual(['app_settings']);
  });

  it('caches the result so repeat calls do not hit the database', async () => {
    stored('https://share.example.com');
    await getShareBaseUrlSettings();
    const callsAfterFirst = query.mock.calls.length;

    await getShareBaseUrlSettings();
    expect(query.mock.calls.length).toBe(callsAfterFirst);
  });

  it('stores the settings under the shared app cache key', async () => {
    stored('https://share.example.com');
    await getShareBaseUrlSettings();
    expect(await getCache(cacheKeys.shareBaseUrlSettings())).toEqual({ url: 'https://share.example.com' });
  });
});

describe('getShareBaseUrlOrigin', () => {
  it('reduces a configured URL to its origin', async () => {
    stored('https://share.example.com/some/path?x=1');
    expect(await getShareBaseUrlOrigin()).toBe('https://share.example.com');
  });

  it('keeps a non-default port', async () => {
    stored('https://share.example.com:8443/');
    expect(await getShareBaseUrlOrigin()).toBe('https://share.example.com:8443');
  });

  it('trims surrounding whitespace before parsing', async () => {
    stored('  https://share.example.com  ');
    expect(await getShareBaseUrlOrigin()).toBe('https://share.example.com');
  });

  it('returns null when nothing is configured', async () => {
    stored(null);
    expect(await getShareBaseUrlOrigin()).toBeNull();
  });

  it('returns null for an unparseable URL rather than throwing', async () => {
    stored('not a url');
    expect(await getShareBaseUrlOrigin()).toBeNull();
  });

  it('returns null when the database is unreachable', async () => {
    query.mockRejectedValue(new Error('connection refused'));
    expect(await getShareBaseUrlOrigin()).toBeNull();
  });
});

describe('getShareBaseHost', () => {
  it('returns the host without the scheme', async () => {
    stored('https://share.example.com/path');
    expect(await getShareBaseHost()).toBe('share.example.com');
  });

  it('includes the port when one is configured', async () => {
    stored('http://share.example.com:8080');
    expect(await getShareBaseHost()).toBe('share.example.com:8080');
  });

  it('returns null when nothing is configured', async () => {
    stored(null);
    expect(await getShareBaseHost()).toBeNull();
  });
});
