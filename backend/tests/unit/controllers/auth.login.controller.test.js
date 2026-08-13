import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ALL_PERMISSIONS, PERMISSIONS } from '../../../utils/permissions.js';
import { mockReq, mockRes } from '../../helpers/http.js';

vi.mock('../../../models/user.model.js', () => ({
  createUserWithGoogle: vi.fn(),
  getAccountContext: vi.fn(),
  getMfaStatus: vi.fn(),
  getSignupEnabled: vi.fn(),
  getUserByEmail: vi.fn(),
  getUserByGoogleId: vi.fn(),
  handleFirstUserSetup: vi.fn(),
  updateGoogleId: vi.fn(),
}));

vi.mock('../../../services/auditLogger.js', () => ({
  loginFailure: vi.fn(async () => {}),
  loginSuccess: vi.fn(async () => {}),
  userSignup: vi.fn(async () => {}),
}));

vi.mock('../../../utils/authSession.js', () => ({
  createSessionAndToken: vi.fn(async () => ({ token: 'issued.jwt.token', sessionId: 'sess-1' })),
  setAuthCookieAndRespond: vi.fn((res, token, payload) => {
    res.cookie('token', token, { httpOnly: true });
    res.json(payload);
  }),
}));

vi.mock('../../../controllers/auth/auth.mfa.controller.js', () => ({
  verifyMfaCode: vi.fn(async () => true),
}));

const models = await import('../../../models/user.model.js');
const audit = await import('../../../services/auditLogger.js');
const session = await import('../../../utils/authSession.js');
const { verifyMfaCode } = await import('../../../controllers/auth/auth.mfa.controller.js');
const { googleMfaVerify, login } = await import('../../../controllers/auth/auth.login.controller.js');

const USER = 'user000000000001';
const PASSWORD_HASH = bcrypt.hashSync('correct-horse', 10);

const userRow = (overrides = {}) => ({
  id: USER,
  email: 'user@example.com',
  password: PASSWORD_HASH,
  name: 'Ada',
  created_at: '2026-01-01T00:00:00.000Z',
  mfa_enabled: false,
  ...overrides,
});

async function attemptLogin(body, reqOverrides = {}) {
  const req = mockReq({ method: 'POST', path: '/api/login', body, ...reqOverrides });
  const res = mockRes();
  await login(req, res);
  return { req, res };
}

beforeEach(() => {
  models.getUserByEmail.mockResolvedValue(userRow());
  models.getMfaStatus.mockResolvedValue({ enabled: false });
  models.getAccountContext.mockResolvedValue({ id: USER, ownerId: USER, permissions: [], isSubUser: false });
  audit.loginFailure.mockResolvedValue(undefined);
  audit.loginSuccess.mockResolvedValue(undefined);
  session.createSessionAndToken.mockResolvedValue({ token: 'issued.jwt.token', sessionId: 'sess-1' });
  session.setAuthCookieAndRespond.mockImplementation((res, token, payload) => {
    res.cookie('token', token, { httpOnly: true });
    res.json(payload);
  });
  verifyMfaCode.mockResolvedValue(true);
});

describe('successful login', () => {
  it('issues a session and returns the user', async () => {
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.body.user).toMatchObject({ id: USER, email: 'user@example.com', name: 'Ada' });
    expect(session.createSessionAndToken).toHaveBeenCalledWith(USER, expect.anything());
  });

  it('sets the auth cookie', async () => {
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.cookie).toHaveBeenCalledWith('token', 'issued.jwt.token', expect.objectContaining({ httpOnly: true }));
  });

  it('never returns the password hash', async () => {
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.body.user).not.toHaveProperty('password');
    expect(JSON.stringify(res.body)).not.toContain(PASSWORD_HASH);
  });

  it('grants an owner every capability', async () => {
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.body.user.isSubUser).toBe(false);
    expect(res.body.user.permissions).toEqual(ALL_PERMISSIONS);
  });

  it("reports a sub-user's own grants, not the owner's", async () => {
    models.getAccountContext.mockResolvedValue({
      id: USER,
      ownerId: 'owner00000000001',
      permissions: [PERMISSIONS.DOWNLOAD],
      isSubUser: true,
    });

    const { res } = await attemptLogin({ email: 'sub@example.com', password: 'correct-horse' });

    expect(res.body.user.isSubUser).toBe(true);
    expect(res.body.user.permissions).toEqual([PERMISSIONS.DOWNLOAD]);
  });

  it('attributes the login to the account the identity acts under', async () => {
    const account = { id: USER, ownerId: 'owner00000000001', permissions: [], isSubUser: true };
    models.getAccountContext.mockResolvedValue(account);

    await attemptLogin({ email: 'sub@example.com', password: 'correct-horse' });

    expect(audit.loginSuccess).toHaveBeenCalledWith(USER, 'sub@example.com', expect.anything(), account);
  });

  it('defaults mfa_enabled to false when the column is null', async () => {
    models.getUserByEmail.mockResolvedValue(userRow({ mfa_enabled: null }));
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.body.user.mfa_enabled).toBe(false);
  });
});

describe('failed login', () => {
  it('rejects an unknown email with a generic message', async () => {
    models.getUserByEmail.mockResolvedValue(undefined);
    const { res } = await attemptLogin({ email: 'nobody@example.com', password: 'anything' });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('Invalid credentials');
  });

  it('rejects a wrong password with the same generic message, so accounts cannot be enumerated', async () => {
    const unknown = await (async () => {
      models.getUserByEmail.mockResolvedValue(undefined);
      return (await attemptLogin({ email: 'nobody@example.com', password: 'x' })).res.body.message;
    })();

    models.getUserByEmail.mockResolvedValue(userRow());
    const wrongPassword = (await attemptLogin({ email: 'user@example.com', password: 'wrong' })).res.body.message;

    expect(wrongPassword).toBe(unknown);
  });

  it('issues no session on a wrong password', async () => {
    await attemptLogin({ email: 'user@example.com', password: 'wrong' });
    expect(session.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('audits the two failure reasons distinctly for the operator', async () => {
    models.getUserByEmail.mockResolvedValue(undefined);
    await attemptLogin({ email: 'nobody@example.com', password: 'x' });
    expect(audit.loginFailure).toHaveBeenCalledWith('nobody@example.com', 'user_not_found', expect.anything());

    audit.loginFailure.mockClear();
    models.getUserByEmail.mockResolvedValue(userRow());
    await attemptLogin({ email: 'user@example.com', password: 'wrong' });
    expect(audit.loginFailure).toHaveBeenCalledWith('user@example.com', 'invalid_password', expect.anything());
  });

  it('answers 500 without leaking internals when the lookup throws', async () => {
    models.getUserByEmail.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });

    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});

describe('multi-factor authentication', () => {
  beforeEach(() => {
    models.getMfaStatus.mockResolvedValue({ enabled: true });
  });

  it('asks for a code when MFA is on and none was supplied', async () => {
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('MFA code required');
    expect(session.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('rejects a non-string code', async () => {
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse', mfaCode: 123456 });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects an incorrect code without issuing a session', async () => {
    verifyMfaCode.mockResolvedValue(false);
    const { res } = await attemptLogin({
      email: 'user@example.com',
      password: 'correct-horse',
      mfaCode: '000000',
    });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('Invalid MFA code');
    expect(session.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('audits a failed code separately from a failed password', async () => {
    verifyMfaCode.mockResolvedValue(false);
    await attemptLogin({ email: 'user@example.com', password: 'correct-horse', mfaCode: '000000' });
    expect(audit.loginFailure).toHaveBeenCalledWith('user@example.com', 'invalid_mfa_code', expect.anything());
  });

  it('completes the login once the code verifies', async () => {
    const { res } = await attemptLogin({
      email: 'user@example.com',
      password: 'correct-horse',
      mfaCode: '123456',
    });

    expect(res.body.user.id).toBe(USER);
    expect(session.createSessionAndToken).toHaveBeenCalled();
  });

  it('checks the password before the code, so MFA cannot be brute-forced alone', async () => {
    await attemptLogin({ email: 'user@example.com', password: 'wrong', mfaCode: '123456' });
    expect(verifyMfaCode).not.toHaveBeenCalled();
  });

  it('skips the code entirely when MFA is off', async () => {
    models.getMfaStatus.mockResolvedValue({ enabled: false });
    await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(verifyMfaCode).not.toHaveBeenCalled();
  });

  it('treats a missing MFA record as MFA being off', async () => {
    models.getMfaStatus.mockResolvedValue(null);
    const { res } = await attemptLogin({ email: 'user@example.com', password: 'correct-horse' });
    expect(res.body.user.id).toBe(USER);
  });
});

describe('googleMfaVerify', () => {
  const SECRET = 'test-jwt-secret-do-not-use-in-production';
  const pendingCookie = (payload, options = {}) =>
    `mfa_pending=${jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '5m', ...options })}`;

  async function verify(body, cookie) {
    const req = mockReq({ method: 'POST', body, headers: cookie ? { cookie } : {} });
    const res = mockRes();
    await googleMfaVerify(req, res);
    return { res };
  }

  it('completes the sign-in for a valid code and pending cookie', async () => {
    const { res } = await verify({ mfaCode: '123456' }, pendingCookie({ userId: USER, purpose: 'mfa_pending' }));
    expect(res.body).toEqual({ success: true });
    expect(session.createSessionAndToken).toHaveBeenCalledWith(USER, expect.anything());
  });

  it('clears the pending cookie once it is spent', async () => {
    const { res } = await verify({ mfaCode: '123456' }, pendingCookie({ userId: USER, purpose: 'mfa_pending' }));
    expect(res.clearCookie).toHaveBeenCalledWith('mfa_pending', expect.anything());
  });

  it('requires an MFA code', async () => {
    const { res } = await verify({}, pendingCookie({ userId: USER, purpose: 'mfa_pending' }));
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body.message).toBe('MFA code required');
  });

  it('rejects a non-string code', async () => {
    const { res } = await verify({ mfaCode: 123456 }, pendingCookie({ userId: USER, purpose: 'mfa_pending' }));
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rejects a request with no pending cookie', async () => {
    const { res } = await verify({ mfaCode: '123456' }, null);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toMatch(/MFA session expired or missing/);
  });

  it('rejects a pending token signed with another secret', async () => {
    const forged = jwt.sign({ userId: 'attacker', purpose: 'mfa_pending' }, 'attacker-secret', { algorithm: 'HS256' });
    const { res } = await verify({ mfaCode: '123456' }, `mfa_pending=${forged}`);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(session.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('rejects an expired pending token and clears it', async () => {
    const expired = jwt.sign({ userId: USER, purpose: 'mfa_pending' }, SECRET, {
      algorithm: 'HS256',
      expiresIn: -60,
    });
    const { res } = await verify({ mfaCode: '123456' }, `mfa_pending=${expired}`);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.clearCookie).toHaveBeenCalledWith('mfa_pending', expect.anything());
  });

  it('rejects a token minted for a different purpose, blocking cookie reuse', async () => {
    const wrongPurpose = jwt.sign({ userId: USER, purpose: 'password_reset' }, SECRET, { algorithm: 'HS256' });
    const { res } = await verify({ mfaCode: '123456' }, `mfa_pending=${wrongPurpose}`);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('Invalid MFA session');
  });

  it('rejects a token carrying no user id', async () => {
    const noUser = jwt.sign({ purpose: 'mfa_pending' }, SECRET, { algorithm: 'HS256' });
    const { res } = await verify({ mfaCode: '123456' }, `mfa_pending=${noUser}`);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects an incorrect code and issues no session', async () => {
    verifyMfaCode.mockResolvedValue(false);
    const { res } = await verify({ mfaCode: '000000' }, pendingCookie({ userId: USER, purpose: 'mfa_pending' }));
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body.message).toBe('Invalid MFA code');
    expect(session.createSessionAndToken).not.toHaveBeenCalled();
  });

  it('finds the pending cookie among others', async () => {
    const cookie = `theme=dark; ${pendingCookie({ userId: USER, purpose: 'mfa_pending' })}; lang=en`;
    const { res } = await verify({ mfaCode: '123456' }, cookie);
    expect(res.body).toEqual({ success: true });
  });

  it('answers 500 without leaking internals when session creation fails', async () => {
    session.createSessionAndToken.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    const { res } = await verify({ mfaCode: '123456' }, pendingCookie({ userId: USER, purpose: 'mfa_pending' }));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});
