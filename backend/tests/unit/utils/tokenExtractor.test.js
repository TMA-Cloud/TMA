import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';

import { extractRawToken, extractTokenFromRequest, getSessionIdFromRequest } from '../../../utils/tokenExtractor.js';

const SECRET = 'test-jwt-secret-do-not-use-in-production';

const sign = (payload, options = {}) => jwt.sign(payload, SECRET, { algorithm: 'HS256', ...options });
const req = headers => ({ headers });

describe('extractRawToken', () => {
  it('reads the token cookie', () => {
    expect(extractRawToken(req({ cookie: 'token=abc.def.ghi' }))).toBe('abc.def.ghi');
  });

  it('finds the token cookie among others, in any position', () => {
    expect(extractRawToken(req({ cookie: 'theme=dark; token=abc123; lang=en' }))).toBe('abc123');
    expect(extractRawToken(req({ cookie: 'token=abc123; theme=dark' }))).toBe('abc123');
  });

  it('tolerates missing spaces after the semicolon', () => {
    expect(extractRawToken(req({ cookie: 'theme=dark;token=abc123' }))).toBe('abc123');
  });

  it('falls back to the Authorization header when there is no cookie', () => {
    expect(extractRawToken(req({ authorization: 'Bearer abc.def.ghi' }))).toBe('abc.def.ghi');
  });

  it('prefers the cookie over the Authorization header', () => {
    const headers = { cookie: 'token=from-cookie', authorization: 'Bearer from-header' };
    expect(extractRawToken(req(headers))).toBe('from-cookie');
  });

  it('returns null when neither source carries a token', () => {
    expect(extractRawToken(req({}))).toBeNull();
    expect(extractRawToken(req({ cookie: 'theme=dark' }))).toBeNull();
  });

  it('returns null for an Authorization header with no value after the scheme', () => {
    expect(extractRawToken(req({ authorization: 'Bearer' }))).toBeNull();
  });

  it('returns an empty string for an empty token cookie', () => {
    expect(extractRawToken(req({ cookie: 'token=' }))).toBe('');
  });

  it('does not match a cookie that merely ends in "token"', () => {
    expect(extractRawToken(req({ cookie: 'csrf_token=abc123' }))).toBeNull();
  });
});

describe('extractTokenFromRequest', () => {
  it('returns the decoded payload for a valid token', () => {
    const token = sign({ id: 'u1', v: 2, sid: 's1' }, { expiresIn: 60 });
    const decoded = extractTokenFromRequest(req({ cookie: `token=${token}` }));
    expect(decoded).toMatchObject({ id: 'u1', v: 2, sid: 's1' });
  });

  it('returns null when there is no token at all', () => {
    expect(extractTokenFromRequest(req({}))).toBeNull();
  });

  it('returns null for a token signed with a different secret', () => {
    const forged = jwt.sign({ id: 'u1' }, 'attacker-secret', { algorithm: 'HS256' });
    expect(extractTokenFromRequest(req({ cookie: `token=${forged}` }))).toBeNull();
  });

  it('returns null for an expired token', () => {
    const expired = sign({ id: 'u1' }, { expiresIn: -60 });
    expect(extractTokenFromRequest(req({ cookie: `token=${expired}` }))).toBeNull();
  });

  it('returns null for structurally invalid input rather than throwing', () => {
    expect(extractTokenFromRequest(req({ cookie: 'token=not-a-jwt' }))).toBeNull();
    expect(extractTokenFromRequest(req({ cookie: 'token=' }))).toBeNull();
  });

  it('rejects an unsigned "alg: none" token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ id: 'attacker' })).toString('base64url');
    expect(extractTokenFromRequest(req({ cookie: `token=${header}.${body}.` }))).toBeNull();
  });
});

describe('getSessionIdFromRequest', () => {
  it('returns the sid claim', () => {
    const token = sign({ id: 'u1', sid: 'sess-abc' }, { expiresIn: 60 });
    expect(getSessionIdFromRequest(req({ cookie: `token=${token}` }))).toBe('sess-abc');
  });

  it('returns null when the token carries no sid', () => {
    const token = sign({ id: 'u1' }, { expiresIn: 60 });
    expect(getSessionIdFromRequest(req({ cookie: `token=${token}` }))).toBeNull();
  });

  it('returns null when the token is missing or invalid', () => {
    expect(getSessionIdFromRequest(req({}))).toBeNull();
    expect(getSessionIdFromRequest(req({ cookie: 'token=garbage' }))).toBeNull();
  });
});
