import { describe, expect, it, vi } from 'vitest';

import { normalizeKnownProxies, resolveKnownProxies } from '../../../utils/knownProxies.js';

describe('normalizeKnownProxies', () => {
  it('normalizes, removes blanks, and de-duplicates entries', () => {
    expect(normalizeKnownProxies([' 10.1.2.100 ', '', 'PROXY.EXAMPLE.COM', '10.1.2.100'])).toEqual([
      '10.1.2.100',
      'proxy.example.com',
    ]);
  });

  it.each(['999.1.1.1', '10.0.0.1/33', '2001:db8::1/129', 'bad host!', '-proxy.example'])(
    'rejects invalid proxy identity %s',
    value => {
      expect(() => normalizeKnownProxies([value])).toThrow(/Invalid proxy/);
    }
  );

  it('accepts IPv4, IPv6, CIDR ranges, and hostnames', () => {
    expect(() =>
      normalizeKnownProxies(['10.0.0.1', '2001:db8::1', '172.18.0.0/16', 'fd00::/8', 'nginx'])
    ).not.toThrow();
  });
});

describe('resolveKnownProxies', () => {
  it('keeps address entries and resolves every hostname address', async () => {
    const lookup = vi.fn(async () => [
      { address: '10.0.0.2', family: 4 },
      { address: 'fd00::2', family: 6 },
    ]);

    await expect(resolveKnownProxies(['10.0.0.1', 'proxy.internal'], lookup)).resolves.toEqual({
      resolved: ['10.0.0.1', '10.0.0.2', 'fd00::2'],
      failures: [],
    });
    expect(lookup).toHaveBeenCalledWith('proxy.internal', { all: true, verbatim: true });
  });

  it('fails closed when a hostname cannot be resolved', async () => {
    const lookup = vi.fn(async () => {
      throw new Error('DNS unavailable');
    });
    await expect(resolveKnownProxies(['proxy.internal'], lookup)).resolves.toEqual({
      resolved: [],
      failures: ['proxy.internal'],
    });
  });
});
