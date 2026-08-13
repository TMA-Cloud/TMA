import { beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';

import { SESSION_IDLE_TTL_SECONDS, TOKEN_RENEWAL_THRESHOLD_SECONDS } from '../../../utils/auth.js';
import { mockNext, mockReq, mockRes, withRequestContext } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  getUserTokenVersion: vi.fn(async () => 1),
  getAccountContext: vi.fn(async () => ({ ownerId: 'owner00000000001', permissions: null, isSubUser: false })),
}));

vi.mock('../../../models/session.model.js', () => ({
  sessionExists: vi.fn(async () => true),
  updateSessionActivity: vi.fn(async () => {}),
}));

const { getAccountContext, getUserTokenVersion } = await import('../../../models/user.model.js');
const { sessionExists, updateSessionActivity } = await import('../../../models/session.model.js');
const authMiddleware = (await import('../../../middleware/auth.middleware.js')).default;

const SECRET = 'test-jwt-secret-do-not-use-in-production';
const USER = 'user000000000001';

const sign = (payload, options = {}) =>
  jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: SESSION_IDLE_TTL_SECONDS, ...options });

// The suite restores mocks between tests, which strips the factory defaults;
// re-establish the "everything is fine" baseline so each test only has to
// declare the one condition it actually cares about.
beforeEach(() => {
  getUserTokenVersion.mockResolvedValue(1);
  getAccountContext.mockResolvedValue({ ownerId: 'owner00000000001', permissions: null, isSubUser: false });
  sessionExists.mockResolvedValue(true);
  updateSessionActivity.mockResolvedValue(undefined);
});

/** Invoke the middleware inside a CLS request context, as the real stack does. */
async function invoke(req, res = mockRes(), next = mockNext()) {
  await withRequestContext(() => authMiddleware(req, res, next));
  return { req, res, next };
}

async function run(token, reqOverrides = {}) {
  const req = mockReq({
    headers: token ? { cookie: `token=${token}` } : {},
    ...reqOverrides,
  });
  return invoke(req);
}

describe('token presence and validity', () => {
  it('rejects a request with no token', async () => {
    const { res, next } = await run(null);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('No token provided');
  });

  it('rejects a token signed with the wrong secret', async () => {
    const forged = jwt.sign({ id: USER, v: 1 }, 'attacker-secret', { algorithm: 'HS256' });
    const { res, next } = await run(forged);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('Invalid token');
  });

  it('rejects an expired token', async () => {
    const { res } = await run(sign({ id: USER, v: 1 }, { expiresIn: -60 }));
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects an unsigned "alg: none" token', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ id: USER, v: 1 })).toString('base64url');
    const { res, next } = await run(`${header}.${body}.`);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('accepts a token from the Authorization header', async () => {
    const req = mockReq({ headers: { authorization: `Bearer ${sign({ id: USER, v: 1 })}` } });
    const { next } = await invoke(req);
    expect(next).toHaveBeenCalled();
  });

  it('populates the request identity on success', async () => {
    const { req, next } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }));
    expect(next).toHaveBeenCalled();
    expect(req.userId).toBe(USER);
    expect(req.sessionId).toBe('sess-1');
  });

  it('sets sessionId to null for a token minted without one', async () => {
    const { req } = await run(sign({ id: USER, v: 1 }));
    expect(req.sessionId).toBeNull();
  });
});

describe('token version', () => {
  it('rejects a token whose version is behind the user record', async () => {
    getUserTokenVersion.mockResolvedValue(3);
    const { res, next } = await run(sign({ id: USER, v: 1 }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toMatch(/Session expired/);
  });

  it('rejects when the user no longer exists', async () => {
    getUserTokenVersion.mockResolvedValue(null);
    const { res, next } = await run(sign({ id: USER, v: 1 }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('Invalid token');
  });

  it('treats a token with no version claim as version 1', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    const { next } = await run(sign({ id: USER }));
    expect(next).toHaveBeenCalled();
  });

  it('accepts a matching non-default version', async () => {
    getUserTokenVersion.mockResolvedValue(9);
    const { next } = await run(sign({ id: USER, v: 9 }));
    expect(next).toHaveBeenCalled();
  });
});

describe('session validation', () => {
  it('rejects a token bound to a revoked session', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    sessionExists.mockResolvedValue(false);
    const { res, next } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toMatch(/revoked/i);
  });

  it('touches the session activity timestamp on a valid request', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    sessionExists.mockResolvedValue(true);
    updateSessionActivity.mockClear();
    await run(sign({ id: USER, v: 1, sid: 'sess-1' }));
    expect(updateSessionActivity).toHaveBeenCalledWith('sess-1');
  });

  it('does not check the session store for a token without a sid', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    sessionExists.mockClear();
    await run(sign({ id: USER, v: 1 }));
    expect(sessionExists).not.toHaveBeenCalled();
  });

  it('survives a failed activity update, since it is fire-and-forget', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    sessionExists.mockResolvedValue(true);
    updateSessionActivity.mockRejectedValue(new Error('redis down'));
    const { next } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }));
    expect(next).toHaveBeenCalled();
  });

  describe('revoking your own session', () => {
    it('allows DELETE /sessions/:id for the session in the token', async () => {
      getUserTokenVersion.mockResolvedValue(1);
      sessionExists.mockResolvedValue(false);
      const { next } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }), {
        method: 'DELETE',
        path: '/sessions/sess-1',
      });
      expect(next).toHaveBeenCalled();
    });

    it('also matches the /api-prefixed path', async () => {
      getUserTokenVersion.mockResolvedValue(1);
      sessionExists.mockResolvedValue(false);
      const { next } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }), {
        method: 'DELETE',
        path: '/api/sessions/sess-1',
      });
      expect(next).toHaveBeenCalled();
    });

    it('does not extend the exemption to a different session id', async () => {
      getUserTokenVersion.mockResolvedValue(1);
      sessionExists.mockResolvedValue(false);
      const { res } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }), {
        method: 'DELETE',
        path: '/sessions/someone-elses',
      });
      expect(res.status).toHaveBeenCalledWith(401);
    });

    it('does not extend the exemption to other verbs', async () => {
      getUserTokenVersion.mockResolvedValue(1);
      sessionExists.mockResolvedValue(false);
      const { res } = await run(sign({ id: USER, v: 1, sid: 'sess-1' }), {
        method: 'POST',
        path: '/sessions/sess-1',
      });
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});

describe('account context', () => {
  it('resolves an owner to itself', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    getAccountContext.mockResolvedValue({ ownerId: USER, permissions: null, isSubUser: false });
    const { req } = await run(sign({ id: USER, v: 1 }));
    expect(req.ownerId).toBe(USER);
    expect(req.isSubUser).toBe(false);
  });

  it('points a sub-user at its owner and attaches the granted permissions', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    getAccountContext.mockResolvedValue({
      ownerId: 'owner00000000001',
      permissions: ['files.download'],
      isSubUser: true,
    });
    const { req } = await run(sign({ id: 'sub00000000000001', v: 1 }));
    expect(req.ownerId).toBe('owner00000000001');
    expect(req.isSubUser).toBe(true);
    expect(req.permissions).toEqual(['files.download']);
  });

  it('rejects the request when the account cannot be resolved', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    getAccountContext.mockResolvedValue(null);
    const { res, next } = await run(sign({ id: USER, v: 1 }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('sliding session renewal', () => {
  it('leaves a fresh token alone', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    const { res } = await run(sign({ id: USER, v: 1 }));
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('re-issues a token that is close to expiry', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    const nearlyExpired = SESSION_IDLE_TTL_SECONDS - TOKEN_RENEWAL_THRESHOLD_SECONDS - 60;
    const { res } = await run(sign({ id: USER, v: 1, sid: 's1' }, { expiresIn: nearlyExpired }));
    expect(res.cookie).toHaveBeenCalledWith('token', expect.any(String), expect.objectContaining({ httpOnly: true }));
  });

  it('carries the version and session id into the renewed token', async () => {
    getUserTokenVersion.mockResolvedValue(4);
    const nearlyExpired = SESSION_IDLE_TTL_SECONDS - TOKEN_RENEWAL_THRESHOLD_SECONDS - 60;
    const { res } = await run(sign({ id: USER, v: 4, sid: 's1' }, { expiresIn: nearlyExpired }));
    const renewed = jwt.decode(res.cookie.mock.calls[0][1]);
    expect(renewed).toMatchObject({ id: USER, v: 4, sid: 's1' });
  });

  it('does not attempt renewal once headers have gone out', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    const nearlyExpired = SESSION_IDLE_TTL_SECONDS - TOKEN_RENEWAL_THRESHOLD_SECONDS - 60;
    const req = mockReq({ headers: { cookie: `token=${sign({ id: USER, v: 1 }, { expiresIn: nearlyExpired })}` } });
    const res = mockRes();
    res.headersSent = true;
    await invoke(req, res);
    expect(res.cookie).not.toHaveBeenCalled();
  });

  it('still lets the request proceed when renewal itself fails', async () => {
    getUserTokenVersion.mockResolvedValue(1);
    const nearlyExpired = SESSION_IDLE_TTL_SECONDS - TOKEN_RENEWAL_THRESHOLD_SECONDS - 60;
    const req = mockReq({ headers: { cookie: `token=${sign({ id: USER, v: 1 }, { expiresIn: nearlyExpired })}` } });
    const res = mockRes();
    res.cookie = vi.fn(() => {
      throw new Error('cookie jar full');
    });
    const { next } = await invoke(req, res);
    expect(next).toHaveBeenCalled();
  });
});
