import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/clientHeartbeat.model.js', () => ({
  upsertClientHeartbeat: vi.fn(async () => ({})),
  getActiveClients: vi.fn(async () => []),
}));
vi.mock('../../../models/user.model.js', () => ({ isFirstUser: vi.fn(async () => true) }));

const { upsertClientHeartbeat } = await import('../../../models/clientHeartbeat.model.js');
const { clientHeartbeat } = await import('../../../controllers/user/user.admin.clients.controller.js');

async function beat(body, reqOverrides = {}) {
  const res = mockRes();
  await clientHeartbeat(mockReq({ userId: 'user-1', sessionId: 'session-1', body, ...reqOverrides }), res);
  return res;
}

describe('clientHeartbeat', () => {
  beforeEach(() => {
    vi.mocked(upsertClientHeartbeat).mockClear();
  });

  it('keys a desktop install by its stable client id', async () => {
    await beat({ appVersion: '1.1.3', platform: 'win32', clientId: ' cid-1 ' });

    expect(upsertClientHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', clientId: 'cid-1', sessionId: 'session-1' })
    );
  });

  it('takes the session from the token, never from the request body', async () => {
    await beat({ appVersion: '1.1.3', sessionId: 'someone-elses-session' });

    expect(upsertClientHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: null, sessionId: 'session-1' })
    );
  });

  it('rejects a heartbeat without an app version', async () => {
    const res = await beat({ clientId: 'cid-1' });

    expect(res.statusCode).toBe(400);
    expect(upsertClientHeartbeat).not.toHaveBeenCalled();
  });
});
