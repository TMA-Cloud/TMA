import { describe, expect, it } from 'vitest';

import {
  getAccountContext,
  getRequestId,
  getUserId,
  requestIdMiddleware,
  setAccountContext,
  setUserId,
} from '../../../middleware/requestId.middleware.js';
import { mockReq, mockRes } from '../../helpers/http.js';

/**
 * Drive the middleware and run assertions inside the context it establishes.
 * The callback is invoked as `next`, which is the only place the CLS namespace
 * is active.
 */
function inContext(headers, assertions) {
  return new Promise((resolve, reject) => {
    const req = mockReq({ headers });
    const res = mockRes();
    requestIdMiddleware(req, res, () => {
      try {
        assertions({ req, res });
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  });
}

describe('requestIdMiddleware', () => {
  it('generates a request id and exposes it on the request', async () => {
    await inContext({}, ({ req }) => {
      expect(req.requestId).toBeTruthy();
      expect(typeof req.requestId).toBe('string');
    });
  });

  it('echoes the id back in the X-Request-ID response header for correlation', async () => {
    await inContext({}, ({ req, res }) => {
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-ID', req.requestId);
    });
  });

  it('honours a client-supplied X-Request-ID so tracing spans the whole call', async () => {
    await inContext({ 'x-request-id': 'client-trace-123' }, ({ req }) => {
      expect(req.requestId).toBe('client-trace-123');
    });
  });

  it('makes the id readable from CLS without threading it through every call', async () => {
    await inContext({}, ({ req }) => {
      expect(getRequestId()).toBe(req.requestId);
    });
  });

  it('generates a distinct id per request', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) {
      await inContext({}, ({ req }) => ids.push(req.requestId));
    }
    expect(new Set(ids).size).toBe(5);
  });

  it('returns null for the request id outside any request', () => {
    expect(getRequestId()).toBeNull();
  });
});

describe('identity propagation', () => {
  it('round-trips the user id set by the auth middleware', async () => {
    await inContext({}, () => {
      setUserId('user000000000001');
      expect(getUserId()).toBe('user000000000001');
    });
  });

  it('round-trips the account context', async () => {
    await inContext({}, () => {
      setAccountContext({ ownerId: 'owner00000000001', isSubUser: true });
      expect(getAccountContext()).toEqual({ ownerId: 'owner00000000001', isSubUser: true });
    });
  });

  it('starts each request with no identity', async () => {
    await inContext({}, () => {
      expect(getUserId()).toBeNull();
      expect(getAccountContext()).toBeNull();
    });
  });

  it('does not leak identity from one request into the next', async () => {
    await inContext({}, () => setUserId('user000000000001'));
    await inContext({}, () => {
      expect(getUserId()).toBeNull();
    });
  });

  it('returns null outside any request rather than throwing', () => {
    expect(getUserId()).toBeNull();
    expect(getAccountContext()).toBeNull();
  });
});
