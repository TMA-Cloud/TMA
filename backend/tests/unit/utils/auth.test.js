import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

import {
  SESSION_IDLE_DAYS,
  SESSION_IDLE_TTL_SECONDS,
  TOKEN_RENEWAL_THRESHOLD_SECONDS,
  generateAuthToken,
  getCookieOptions,
} from '../../../utils/auth.js';

const SECRET = 'test-jwt-secret-do-not-use-in-production';

describe('session window constants', () => {
  it('defaults to a 30 day idle window', () => {
    expect(SESSION_IDLE_DAYS).toBe(30);
    expect(SESSION_IDLE_TTL_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it('renews at 80% of the window, leaving slack for clock skew', () => {
    expect(TOKEN_RENEWAL_THRESHOLD_SECONDS).toBe(Math.floor(SESSION_IDLE_TTL_SECONDS * 0.8));
    expect(TOKEN_RENEWAL_THRESHOLD_SECONDS).toBeLessThan(SESSION_IDLE_TTL_SECONDS);
    expect(TOKEN_RENEWAL_THRESHOLD_SECONDS).toBeGreaterThan(0);
  });
});

describe('getCookieOptions', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.FORCE_INSECURE_COOKIES;
    delete process.env.BACKEND_URL;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv.NODE_ENV;
    process.env.BACKEND_URL = originalEnv.BACKEND_URL;
    delete process.env.FORCE_INSECURE_COOKIES;
  });

  it('always marks the cookie httpOnly and SameSite=lax', () => {
    const options = getCookieOptions();
    expect(options.httpOnly).toBe(true);
    expect(options.sameSite).toBe('lax');
  });

  it('sets maxAge to the full idle window in milliseconds', () => {
    expect(getCookieOptions().maxAge).toBe(SESSION_IDLE_TTL_SECONDS * 1000);
  });

  it('leaves Secure off outside production so local HTTP development works', () => {
    process.env.NODE_ENV = 'development';
    expect(getCookieOptions().secure).toBe(false);
  });

  it('turns Secure on in production over HTTPS', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'https://cloud.example.com';
    expect(getCookieOptions().secure).toBe(true);
  });

  it('turns Secure off in production when BACKEND_URL is plain HTTP, or login would break', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'http://cloud.example.com';
    expect(getCookieOptions().secure).toBe(false);
  });

  it('matches the HTTP scheme case-insensitively', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'HTTP://cloud.example.com';
    expect(getCookieOptions().secure).toBe(false);
  });

  it('honours the explicit FORCE_INSECURE_COOKIES escape hatch', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'https://cloud.example.com';
    process.env.FORCE_INSECURE_COOKIES = 'true';
    expect(getCookieOptions().secure).toBe(false);
  });

  it('ignores FORCE_INSECURE_COOKIES set to anything but the exact string "true"', () => {
    process.env.NODE_ENV = 'production';
    process.env.BACKEND_URL = 'https://cloud.example.com';
    process.env.FORCE_INSECURE_COOKIES = '1';
    expect(getCookieOptions().secure).toBe(true);
  });

  it('defaults to Secure in production when BACKEND_URL is unset', () => {
    process.env.NODE_ENV = 'production';
    expect(getCookieOptions().secure).toBe(true);
  });
});

describe('generateAuthToken', () => {
  it('mints a token carrying the user id and token version', () => {
    const token = generateAuthToken('user000000000001', SECRET, { tokenVersion: 7 });
    const decoded = jwt.verify(token, SECRET, { algorithms: ['HS256'] });
    expect(decoded.id).toBe('user000000000001');
    expect(decoded.v).toBe(7);
  });

  it('defaults the token version to 1', () => {
    const decoded = jwt.decode(generateAuthToken('user000000000001', SECRET));
    expect(decoded.v).toBe(1);
  });

  it('includes the session id when one is supplied, for per-session revocation', () => {
    const decoded = jwt.decode(generateAuthToken('u1', SECRET, { sessionId: 'sess-123' }));
    expect(decoded.sid).toBe('sess-123');
  });

  it('omits the session id entirely when there is none', () => {
    const decoded = jwt.decode(generateAuthToken('u1', SECRET));
    expect(decoded).not.toHaveProperty('sid');
  });

  it('signs with HS256 and no other algorithm, blocking algorithm-confusion attacks', () => {
    const token = generateAuthToken('u1', SECRET);
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString());
    expect(header.alg).toBe('HS256');
    expect(() => jwt.verify(token, SECRET, { algorithms: ['RS256'] })).toThrow();
  });

  it('rejects a token signed with the wrong secret', () => {
    const token = generateAuthToken('u1', SECRET);
    expect(() => jwt.verify(token, 'a-different-secret')).toThrow();
  });

  it('expires after the idle window by default', () => {
    const decoded = jwt.decode(generateAuthToken('u1', SECRET));
    const lifetime = decoded.exp - decoded.iat;
    expect(lifetime).toBe(SESSION_IDLE_TTL_SECONDS);
  });

  it('honours an explicit expiresIn', () => {
    const decoded = jwt.decode(generateAuthToken('u1', SECRET, { expiresIn: 60 }));
    expect(decoded.exp - decoded.iat).toBe(60);
  });

  it.each([
    ['empty user id', '', SECRET],
    ['null user id', null, SECRET],
    ['non-string user id', 123, SECRET],
  ])('throws on %s', (_label, userId, secret) => {
    expect(() => generateAuthToken(userId, secret)).toThrow(/userId must be a non-empty string/);
  });

  it.each([
    ['empty secret', ''],
    ['null secret', null],
    ['non-string secret', 123],
  ])('throws on %s', (_label, secret) => {
    expect(() => generateAuthToken('u1', secret)).toThrow(/jwtSecret must be a non-empty string/);
  });

  it('does not leak anything beyond id, version, session and timestamps', () => {
    const decoded = jwt.decode(generateAuthToken('u1', SECRET, { sessionId: 's1' }));
    expect(Object.keys(decoded).sort()).toEqual(['exp', 'iat', 'id', 'sid', 'v']);
  });
});
