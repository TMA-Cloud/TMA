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
 * The callback is invoked as `next`, which is the only place the request
 * context is active. Async callbacks are awaited, so a failure inside one
 * still fails the test.
 */
function inContext(headers, assertions) {
  return new Promise((resolve, reject) => {
    const req = mockReq({ headers });
    const res = mockRes();
    requestIdMiddleware(req, res, () => {
      Promise.resolve()
        .then(() => assertions({ req, res }))
        .then(resolve, reject);
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

  it.each([
    ['a CRLF injection attempt', 'abc\r\nX-Injected: 1'],
    ['a newline', 'abc\ndef'],
    ['spaces that would break log parsing', 'abc def'],
    ['quotes', 'abc"def'],
    ['an over-long value', 'a'.repeat(129)],
    ['an empty value', ''],
  ])('ignores %s and mints its own id instead', async (_label, header) => {
    await inContext({ 'x-request-id': header }, ({ req }) => {
      expect(req.requestId).not.toBe(header);
      expect(req.requestId).toMatch(/^[A-Za-z0-9._-]{1,128}$/);
    });
  });

  it('accepts the id formats tracing tools actually send', async () => {
    for (const id of ['550e8400-e29b-41d4-a716-446655440000', 'a'.repeat(128), 'trace.span_1-2']) {
      await inContext({ 'x-request-id': id }, ({ req }) => {
        expect(req.requestId).toBe(id);
      });
    }
  });

  it('makes the id readable from the context without threading it through every call', async () => {
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

  it('refuses to set an identity outside a request, rather than dropping it silently', () => {
    expect(() => setUserId('user000000000001')).toThrow(/outside a request context/);
    expect(() => setAccountContext({ ownerId: 'owner00000000001' })).toThrow(/outside a request context/);
  });
});

describe('context propagation across async boundaries', () => {
  it('survives await points, so late audit writes still know the request', async () => {
    await inContext({}, async ({ req }) => {
      setUserId('user000000000001');
      await new Promise(resolve => {
        setImmediate(resolve);
      });
      await Promise.resolve();
      expect(getRequestId()).toBe(req.requestId);
      expect(getUserId()).toBe('user000000000001');
    });
  });

  it('keeps concurrent requests from reading each other identities', async () => {
    const seen = [];

    // The first yields before reading back what it wrote, so a shared store
    // would hand it the second request's id.
    const first = inContext({ 'x-request-id': 'req-a' }, async () => {
      setUserId('user00000000000a');
      await new Promise(resolve => {
        setTimeout(resolve, 10);
      });
      seen.push([getRequestId(), getUserId()]);
    });

    const second = inContext({ 'x-request-id': 'req-b' }, async () => {
      setUserId('user00000000000b');
      seen.push([getRequestId(), getUserId()]);
    });

    await Promise.all([first, second]);

    expect(seen).toContainEqual(['req-a', 'user00000000000a']);
    expect(seen).toContainEqual(['req-b', 'user00000000000b']);
  });
});
