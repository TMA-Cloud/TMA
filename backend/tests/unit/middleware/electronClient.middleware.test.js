import { describe, expect, it, vi } from 'vitest';

import {
  ELECTRON_HEADER_EXPECTED_VALUE,
  ELECTRON_HEADER_NAME,
  requireElectronClientIfEnabled,
} from '../../../middleware/electronClient.middleware.js';
import { mockNext, mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  getElectronOnlyAccessSettings: vi.fn(async () => false),
}));

const { getElectronOnlyAccessSettings } = await import('../../../models/user.model.js');

async function run(path, headers = {}, { accept = 'application/json' } = {}) {
  const req = mockReq({ path, headers: { accept, ...headers } });
  const res = mockRes();
  const next = mockNext();
  await requireElectronClientIfEnabled(req, res, next);
  return { res, next };
}

const desktopHeader = { [ELECTRON_HEADER_NAME]: ELECTRON_HEADER_EXPECTED_VALUE };

describe('when the setting is off', () => {
  it('lets every request through without a header', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(false);
    const { next } = await run('/api/files');
    expect(next).toHaveBeenCalled();
  });
});

describe('when the setting is on', () => {
  it('allows a request carrying the desktop header', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { next } = await run('/api/files', desktopHeader);
    expect(next).toHaveBeenCalled();
  });

  it('blocks a browser request with 403 JSON', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { next, res } = await run('/api/files');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toEqual({
      message: 'This instance is configured for desktop app access only.',
      error: 'DESKTOP_ONLY_ACCESS',
    });
  });

  it('requires the header value to match exactly', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { res } = await run('/api/files', { [ELECTRON_HEADER_NAME]: 'tma-electron-client-v0' });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects an empty header value', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { res } = await run('/api/files', { [ELECTRON_HEADER_NAME]: '' });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(['/s/AbC123xyz789QWer', '/health', '/metrics'])('always allows %s', async path => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { next } = await run(path);
    expect(next).toHaveBeenCalled();
  });

  it('serves a branded HTML page to a browser hitting a non-API route', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { res } = await run('/', {}, { accept: 'text/html' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.type).toHaveBeenCalledWith('html');
    expect(res.body).toContain('Access restricted to the desktop app');
  });

  it('still answers with JSON for an API route even when HTML is accepted', async () => {
    getElectronOnlyAccessSettings.mockResolvedValue(true);
    const { res } = await run('/api/files', {}, { accept: 'text/html' });
    expect(res.body).toEqual(expect.objectContaining({ error: 'DESKTOP_ONLY_ACCESS' }));
  });
});

describe('failure handling', () => {
  it('fails open when the setting cannot be read, so an admin is never locked out', async () => {
    getElectronOnlyAccessSettings.mockRejectedValue(new Error('database unreachable'));
    const { next, res } = await run('/api/files');
    expect(next).toHaveBeenCalled();
    expect(res.sent).toBe(false);
  });
});

describe('exported constants', () => {
  it('keeps the header name and value stable, since the Electron client hard-codes them', () => {
    expect(ELECTRON_HEADER_NAME).toBe('X-TMA-Desktop-Client');
    expect(ELECTRON_HEADER_EXPECTED_VALUE).toBe('tma-electron-client-v1');
  });
});
