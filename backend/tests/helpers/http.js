/**
 * Lightweight Express test doubles.
 *
 * Most middleware here is small enough that spinning up a server per assertion
 * is wasteful; `mockReq`/`mockRes` capture what a handler did (status, body,
 * headers, cookies) without any I/O. `buildApp` is for the cases where the real
 * routing/validation stack is the thing under test.
 */

import { EventEmitter } from 'events';

import express from 'express';
import { vi } from 'vitest';

/**
 * Build a fake Express request.
 * @param {Object} [overrides] - Any request field: method, path, headers, body, params, query, userId, ownerId...
 */
function mockReq(overrides = {}) {
  const headers = {};
  for (const [key, value] of Object.entries(overrides.headers || {})) {
    headers[key.toLowerCase()] = value;
  }

  const req = {
    method: 'GET',
    path: '/',
    originalUrl: overrides.path || '/',
    protocol: 'https',
    ip: '127.0.0.1',
    body: {},
    params: {},
    query: {},
    socket: { remoteAddress: '127.0.0.1' },
    ...overrides,
    headers,
    get(name) {
      const key = String(name).toLowerCase();
      if (key === 'host') return headers.host ?? 'cloud.example.com';
      return headers[key];
    },
    accepts(type) {
      const accept = headers.accept || '';
      return accept.includes(type) || accept.includes('*/*') ? type : false;
    },
  };

  return req;
}

/**
 * Build a fake Express response that records everything written to it.
 * Extends EventEmitter because streaming code listens for 'close' / 'error'.
 */
function mockRes() {
  const res = new EventEmitter();

  res.statusCode = 200;
  res.headersSent = false;
  res.body = undefined;
  res.headers = {};
  res.cookies = {};
  res.sent = false;

  res.status = vi.fn(code => {
    res.statusCode = code;
    return res;
  });

  res.json = vi.fn(payload => {
    res.body = payload;
    res.headersSent = true;
    res.sent = true;
    return res;
  });

  res.send = vi.fn(payload => {
    res.body = payload;
    res.headersSent = true;
    res.sent = true;
    return res;
  });

  res.end = vi.fn(payload => {
    if (payload !== undefined) res.body = payload;
    res.headersSent = true;
    res.sent = true;
    return res;
  });

  res.setHeader = vi.fn((name, value) => {
    res.headers[String(name).toLowerCase()] = value;
    return res;
  });

  res.getHeader = vi.fn(name => res.headers[String(name).toLowerCase()]);

  res.type = vi.fn(value => {
    res.headers['content-type'] = value;
    return res;
  });

  res.cookie = vi.fn((name, value, options) => {
    res.cookies[name] = { value, options };
    return res;
  });

  res.clearCookie = vi.fn(name => {
    delete res.cookies[name];
    return res;
  });

  res.redirect = vi.fn(location => {
    res.headers.location = location;
    res.headersSent = true;
    res.sent = true;
    return res;
  });

  res.sendFile = vi.fn((filePath, cb) => {
    res.body = filePath;
    res.headersSent = true;
    if (typeof cb === 'function') cb();
    return res;
  });

  res.write = vi.fn(() => true);
  res.flushHeaders = vi.fn();
  res.destroy = vi.fn();

  return res;
}

/** A `next` spy that also records the error it was called with, if any. */
function mockNext() {
  const next = vi.fn();
  Object.defineProperty(next, 'error', {
    get: () => next.mock.calls[0]?.[0],
  });
  return next;
}

/**
 * Run a single middleware against fake req/res and resolve once it either
 * calls next() or writes a response.
 * @returns {Promise<{req, res, next}>}
 */
async function runMiddleware(middleware, req = mockReq(), res = mockRes()) {
  const next = mockNext();
  await middleware(req, res, next);
  return { req, res, next };
}

/**
 * Run a callback inside the request context.
 *
 * Anything that calls setUserId/setAccountContext (the auth middleware, the
 * audit logger) throws outside an active context, because in production
 * requestIdMiddleware has always established one first.
 *
 * @param {Function} fn - Callback; its resolved value is returned.
 */
async function withRequestContext(fn) {
  const { runInRequestContext } = await import('../../middleware/requestId.middleware.js');
  return runInRequestContext(async () => fn(), { requestId: 'test-request-id' });
}

/**
 * Mount handlers on a real Express app for supertest.
 * @param {Function} mount - Receives the app; register routes/middleware on it.
 * @param {Object} [options]
 * @param {boolean} [options.json=true] - Install the JSON body parser.
 * @param {Function} [options.errorHandler] - Error middleware to install last.
 */
function buildApp(mount, { json = true, errorHandler } = {}) {
  const app = express();
  app.set('trust proxy', true);
  if (json) app.use(express.json());
  mount(app);
  if (errorHandler) app.use(errorHandler);
  return app;
}

/**
 * Middleware that stamps an authenticated identity onto the request, standing
 * in for auth.middleware.js in route-level tests.
 */
function fakeAuth({ userId = 'user000000000001', ownerId = null, isSubUser = false, permissions = null } = {}) {
  return (req, _res, next) => {
    req.userId = userId;
    req.ownerId = ownerId || userId;
    req.isSubUser = isSubUser;
    req.permissions = permissions;
    next();
  };
}

export { mockReq, mockRes, mockNext, runMiddleware, buildApp, fakeAuth, withRequestContext };
