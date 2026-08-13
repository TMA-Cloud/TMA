import { describe, expect, it } from 'vitest';

import { alwaysReturn } from '../../mocks/db.mock.js';
import { blockMainAppOnShareDomain } from '../../../middleware/shareDomain.middleware.js';
import { mockNext, mockReq, mockRes } from '../../helpers/http.js';

/** Configure (or clear) the share base URL in app_settings. */
function configureShareDomain(url) {
  alwaysReturn({ rows: url === null ? [] : [{ share_base_url: url }], rowCount: url === null ? 0 : 1 });
}

async function run(path, host, method = 'GET') {
  const req = mockReq({ path, method, headers: { host } });
  const res = mockRes();
  const next = mockNext();
  await blockMainAppOnShareDomain(req, res, next);
  return { res, next };
}

describe('when no share domain is configured', () => {
  it('lets every request through', async () => {
    configureShareDomain(null);
    for (const path of ['/', '/api/files', '/s/abc', '/health']) {
      const { next } = await run(path, 'cloud.example.com');
      expect(next).toHaveBeenCalled();
    }
  });
});

describe('requests to the main app host', () => {
  it('are unaffected by the share domain configuration', async () => {
    configureShareDomain('https://share.example.com');
    const { next, res } = await run('/api/files', 'cloud.example.com');
    expect(next).toHaveBeenCalled();
    expect(res.sent).toBe(false);
  });
});

describe('requests to the share domain', () => {
  it('allows share link routes', async () => {
    configureShareDomain('https://share.example.com');
    const { next } = await run('/s/AbC123xyz789QWer', 'share.example.com');
    expect(next).toHaveBeenCalled();
  });

  it('allows the health and metrics endpoints for monitoring', async () => {
    configureShareDomain('https://share.example.com');
    expect((await run('/health', 'share.example.com')).next).toHaveBeenCalled();
    expect((await run('/metrics', 'share.example.com')).next).toHaveBeenCalled();
  });

  it.each(['/', '/api/files', '/api/login', '/assets/index.js', '/settings'])(
    'blocks %s with a bare 404, leaking nothing about the main app',
    async path => {
      configureShareDomain('https://share.example.com');
      const { next, res } = await run(path, 'share.example.com');
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.body).toBe('Not Found');
    }
  );

  it('blocks state-changing requests too', async () => {
    configureShareDomain('https://share.example.com');
    const { res } = await run('/api/files/delete', 'share.example.com', 'POST');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('matches the host case-insensitively', async () => {
    configureShareDomain('https://share.example.com');
    const { res } = await run('/api/files', 'SHARE.EXAMPLE.COM');
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('does not treat a lookalike host as the share domain', async () => {
    configureShareDomain('https://share.example.com');
    expect((await run('/api/files', 'share.example.com.evil.test')).next).toHaveBeenCalled();
    expect((await run('/api/files', 'notshare.example.com')).next).toHaveBeenCalled();
  });

  it('distinguishes hosts by port', async () => {
    configureShareDomain('https://share.example.com:8443');
    expect((await run('/api/files', 'share.example.com')).next).toHaveBeenCalled();
    expect((await run('/api/files', 'share.example.com:8443')).res.status).toHaveBeenCalledWith(404);
  });

  it('honours X-Forwarded-Host from a reverse proxy', async () => {
    configureShareDomain('https://share.example.com');
    const req = mockReq({
      path: '/api/files',
      headers: { host: 'internal:3000', 'x-forwarded-host': 'share.example.com' },
    });
    const res = mockRes();
    const next = mockNext();
    await blockMainAppOnShareDomain(req, res, next);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('does not treat a path that merely starts with /s as a share route', async () => {
    configureShareDomain('https://share.example.com');
    const { res } = await run('/settings', 'share.example.com');
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
