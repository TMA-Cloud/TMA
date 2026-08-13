import { describe, expect, it } from 'vitest';
import request from 'supertest';

import * as limiters from '../../../middleware/rateLimit.middleware.js';
import {
  authRateLimiter,
  backupCodeRegenerationRateLimiter,
  createSSEConnectionLimiter,
  mfaRateLimiter,
  uploadRateLimiter,
} from '../../../middleware/rateLimit.middleware.js';
import shareRoutes from '../../../routes/share.routes.js';
import { buildApp, fakeAuth, mockNext, mockReq, mockRes } from '../../helpers/http.js';

describe('createSSEConnectionLimiter', () => {
  function connect(limiter, userId) {
    const req = mockReq({ userId });
    const res = mockRes();
    const next = mockNext();
    limiter(req, res, next);
    return { res, next, close: () => res.emit('close') };
  }

  it('allows connections up to the cap', () => {
    const limiter = createSSEConnectionLimiter(2);
    expect(connect(limiter, 'u1').next).toHaveBeenCalled();
    expect(connect(limiter, 'u1').next).toHaveBeenCalled();
  });

  it('rejects the connection past the cap with 429', () => {
    const limiter = createSSEConnectionLimiter(2);
    connect(limiter, 'u2');
    connect(limiter, 'u2');
    const third = connect(limiter, 'u2');
    expect(third.next).not.toHaveBeenCalled();
    expect(third.res.status).toHaveBeenCalledWith(429);
    expect(third.res.body.error).toMatch(/Too many active connections/);
  });

  it('frees a slot when a connection closes', () => {
    const limiter = createSSEConnectionLimiter(1);
    const first = connect(limiter, 'u3');
    expect(connect(limiter, 'u3').next).not.toHaveBeenCalled();
    first.close();
    expect(connect(limiter, 'u3').next).toHaveBeenCalled();
  });

  it('does not double-count a connection that emits close twice', () => {
    const limiter = createSSEConnectionLimiter(1);
    const first = connect(limiter, 'u4');
    first.close();
    first.close();
    connect(limiter, 'u4');
    expect(connect(limiter, 'u4').next).not.toHaveBeenCalled();
  });

  it('counts each user separately', () => {
    const limiter = createSSEConnectionLimiter(1);
    connect(limiter, 'u5');
    expect(connect(limiter, 'u6').next).toHaveBeenCalled();
  });

  it('skips limiting entirely for an unauthenticated request', () => {
    const limiter = createSSEConnectionLimiter(1);
    expect(connect(limiter, undefined).next).toHaveBeenCalled();
    expect(connect(limiter, undefined).next).toHaveBeenCalled();
  });
});

describe('authRateLimiter', () => {
  const app = buildApp(a => {
    a.post('/login', authRateLimiter, (_req, res) => res.json({ ok: true }));
  });

  it('allows a normal login attempt', async () => {
    const res = await request(app).post('/login').send({ email: 'a@b.com' });
    expect(res.status).toBe(200);
  });

  it('advertises the remaining budget through standard RateLimit headers', async () => {
    const res = await request(app).post('/login').send({ email: 'headers@b.com' });
    expect(res.headers).toHaveProperty('ratelimit-remaining');
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('blocks with 429 once the window budget is spent', async () => {
    const email = 'burst@example.com';
    let last;
    for (let i = 0; i < 26; i++) {
      last = await request(app).post('/login').send({ email });
    }
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/Too many requests/);
  });

  it('keys on the email as well as the IP, so one target cannot lock out another', async () => {
    const email = 'victim@example.com';
    for (let i = 0; i < 26; i++) await request(app).post('/login').send({ email });

    const other = await request(app).post('/login').send({ email: 'bystander@example.com' });
    expect(other.status).toBe(200);
  });

  it('skips preflight OPTIONS requests', async () => {
    const email = 'options@example.com';
    for (let i = 0; i < 30; i++) await request(app).options('/login').send({ email });
    expect((await request(app).post('/login').send({ email })).status).toBe(200);
  });
});

describe('mfaRateLimiter', () => {
  const app = buildApp(a => {
    a.post('/mfa', fakeAuth({ userId: 'mfa-user' }), mfaRateLimiter, (_req, res) => res.json({ ok: true }));
  });

  it('is far stricter than the auth limiter, because verification is CPU-bound', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await request(app).post('/mfa').send({ code: '000000' });
    expect(last.status).toBe(429);
    expect(last.body.error).toMatch(/MFA verification attempts/);
  });
});

/**
 * The documented contract, from the wiki's Rate Limits reference. These pin the
 * numbers so a change to a limiter is a deliberate edit here as well.
 */
describe('documented limits', () => {
  /** express-rate-limit keeps its options on the middleware's closure, so
   *  drive each limiter until it refuses and count the requests it allowed. */
  async function budgetOf(limiter, { path = '/probe', key = {} } = {}) {
    const app = buildApp(a => {
      a.post(
        path,
        (req, _res, next) => {
          Object.assign(req, key);
          next();
        },
        limiter,
        (_req, res) => res.json({ ok: true })
      );
    });

    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const res = await request(app)
        .post(path)
        .send({ email: `budget-${Math.random()}@example.com` });
      if (res.status === 429) break;
      allowed++;
    }
    return allowed;
  }

  it('allows 25 authentication attempts per window', async () => {
    const app = buildApp(a => a.post('/login', authRateLimiter, (_req, res) => res.json({ ok: true })));
    let allowed = 0;
    for (let i = 0; i < 30; i++) {
      const res = await request(app).post('/login').send({ email: 'fixed@example.com' });
      if (res.status === 429) break;
      allowed++;
    }
    expect(allowed).toBe(25);
  });

  it('allows 5 MFA verification attempts per window', async () => {
    expect(await budgetOf(mfaRateLimiter, { path: '/mfa', key: { userId: 'mfa-budget' } })).toBe(5);
  });

  it('allows 3 backup-code regenerations per window', async () => {
    expect(await budgetOf(backupCodeRegenerationRateLimiter, { path: '/codes', key: { userId: 'codes-budget' } })).toBe(
      3
    );
  });

  it('caps concurrent SSE connections at 20 per user', () => {
    // The exported limiter is built with a cap of 20; prove it by opening 21.
    const limiter = limiters.sseConnectionLimiter;
    const open = [];
    for (let i = 0; i < 20; i++) {
      const res = mockRes();
      const next = mockNext();
      limiter(mockReq({ userId: 'sse-budget' }), res, next);
      open.push({ res, next });
    }
    expect(open.every(o => o.next.mock.calls.length === 1)).toBe(true);

    const overflow = mockRes();
    const overflowNext = mockNext();
    limiter(mockReq({ userId: 'sse-budget' }), overflow, overflowNext);

    expect(overflowNext).not.toHaveBeenCalled();
    expect(overflow.status).toHaveBeenCalledWith(429);

    for (const o of open) o.res.emit('close');
  });

  it('exposes exactly the limiters the reference describes, and no share limiter', () => {
    // Pinned: the wiki documents a "Public Share Link Limiter" at 100 requests
    // per 15 minutes for /s/*, but no such limiter exists. See the share-route
    // test below for what /s/* actually gets.
    expect(Object.keys(limiters).sort()).toEqual([
      'apiRateLimiter',
      'authRateLimiter',
      'backupCodeRegenerationRateLimiter',
      'createSSEConnectionLimiter',
      'mfaRateLimiter',
      'sseConnectionLimiter',
      'uploadRateLimiter',
    ]);
  });

  it('gives public share links the general 10000-per-window limiter, not the documented 100', async () => {
    // The wiki (Reference → Rate Limits) promises:
    //   "Public Share Link Limiter — 100 requests per 15 minutes per IP address.
    //    Purpose: Protects public share links from scraping and denial-of-service."
    // routes/share.routes.js applies apiRateLimiter instead, which allows 10000
    // per 15 minutes — a 100x gap on the one surface open to anonymous traffic.
    // Pinned so adding the real limiter shows up as an intentional change.
    const app = buildApp(a => a.use('/s', shareRoutes));

    let allowed = 0;
    for (let i = 0; i < 120; i++) {
      const res = await request(app).get('/s/AAAAAAAAAAAAAAAA');
      if (res.status === 429) break;
      allowed++;
    }

    expect(allowed).toBe(120);
  });

  it('keys uploads per user so one account cannot exhaust another', async () => {
    const app = buildApp(a => {
      a.post(
        '/upload',
        (req, _res, next) => {
          req.userId = req.headers['x-test-user'];
          next();
        },
        uploadRateLimiter,
        (_req, res) => res.json({ ok: true })
      );
    });

    const first = await request(app).post('/upload').set('x-test-user', 'user-a');
    const second = await request(app).post('/upload').set('x-test-user', 'user-b');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers['ratelimit-remaining']).toBe(second.headers['ratelimit-remaining']);
  });
});
