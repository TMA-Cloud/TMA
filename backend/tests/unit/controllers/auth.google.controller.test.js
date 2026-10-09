import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mockReq, mockRes } from '../../helpers/http.js';

const google = {
  generateCodeVerifierAsync: vi.fn(async () => ({ codeVerifier: 'verifier-123', codeChallenge: 'challenge-abc' })),
  generateAuthUrl: vi.fn(opts => `https://accounts.example/auth?state=${opts.state}`),
  getToken: vi.fn(async () => ({ tokens: { id_token: 'id.token' } })),
  verifyIdToken: vi.fn(),
};

vi.mock('google-auth-library', () => ({ CodeChallengeMethod: { S256: 'S256' } }));

// Google sign-in is on when the first user has saved a client in Settings.
const googleConfig = {
  clientId: '123-abc.apps.googleusercontent.com',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost/api/google/callback',
  version: 1,
};
vi.mock('../../../config/googleAuth.js', () => ({
  getGoogleAuthConfig: vi.fn(async () => googleConfig),
  oauthClientFor: vi.fn(() => google),
}));

vi.mock('../../../models/user.model.js', () => ({
  createUserWithGoogle: vi.fn(),
  getAccountContext: vi.fn(async () => ({ ownerId: 'u1', isSubUser: false })),
  getMfaStatus: vi.fn(async () => ({ enabled: false })),
  getSignupEnabled: vi.fn(async () => true),
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
  createSessionAndToken: vi.fn(async () => ({ token: 'issued.jwt.token' })),
  setAuthCookieAndRespond: vi.fn(),
}));

vi.mock('../../../controllers/auth/auth.mfa.controller.js', () => ({ verifyMfaCode: vi.fn() }));

const models = await import('../../../models/user.model.js');
const { getGoogleAuthConfig } = await import('../../../config/googleAuth.js');
const { googleEnabled, googleLogin, googleCallback } =
  await import('../../../controllers/auth/auth.login.controller.js');

/** Start a flow and return the cookie + state a real browser would carry back. */
async function startFlow() {
  const res = mockRes();
  await googleLogin(mockReq({ method: 'GET' }), res);
  const cookie = res.cookies.oauth_flow.value;
  const state = new URL(res.redirect.mock.calls[0][0]).searchParams.get('state');
  return { cookie, state };
}

function callback({ cookie, state, code = 'auth-code' }) {
  const res = mockRes();
  const req = mockReq({
    method: 'GET',
    query: { code, ...(state !== undefined ? { state } : {}) },
    headers: cookie ? { cookie: `oauth_flow=${encodeURIComponent(cookie)}` } : {},
  });
  return googleCallback(req, res).then(() => res);
}

beforeEach(() => {
  vi.clearAllMocks();
  getGoogleAuthConfig.mockResolvedValue(googleConfig);
  google.verifyIdToken.mockResolvedValue({
    getPayload: () => ({ sub: 'g-1', email: 'ada@example.com', email_verified: true, name: 'Ada' }),
  });
  models.getUserByGoogleId.mockResolvedValue({ id: 'u1', email: 'ada@example.com' });
});

describe('while Google sign-in is off', () => {
  beforeEach(() => getGoogleAuthConfig.mockResolvedValue(null));

  it('tells the login page not to offer it', async () => {
    const res = mockRes();
    await googleEnabled(mockReq({ method: 'GET' }), res);
    expect(res.json).toHaveBeenCalledWith({ enabled: false });
  });

  it('refuses to start a flow', async () => {
    const res = mockRes();
    await googleLogin(mockReq({ method: 'GET' }), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(google.generateAuthUrl).not.toHaveBeenCalled();
  });

  it('refuses a callback, so a flow begun before it was turned off cannot finish', async () => {
    const res = await callback({ cookie: 'state.verifier', state: 'state' });
    expect(res.status).toHaveBeenCalledWith(503);
    expect(google.getToken).not.toHaveBeenCalled();
  });
});

describe('googleEnabled', () => {
  it('offers Google sign-in once a client is saved', async () => {
    const res = mockRes();
    await googleEnabled(mockReq({ method: 'GET' }), res);
    expect(res.json).toHaveBeenCalledWith({ enabled: true });
  });
});

describe('googleLogin', () => {
  it('sends state and a PKCE S256 challenge, without asking for offline access', async () => {
    await startFlow();
    const opts = google.generateAuthUrl.mock.calls[0][0];
    expect(opts.state).toMatch(/^[\w-]{20,}$/);
    expect(opts.code_challenge).toBe('challenge-abc');
    expect(opts.code_challenge_method).toBe('S256');
    expect(opts.access_type).toBeUndefined();
  });
});

describe('googleCallback', () => {
  it('signs in when state matches, redeeming the code with the PKCE verifier', async () => {
    const flow = await startFlow();
    const res = await callback(flow);
    expect(google.getToken).toHaveBeenCalledWith({ code: 'auth-code', codeVerifier: 'verifier-123' });
    expect(google.verifyIdToken).toHaveBeenCalledWith({ idToken: 'id.token', audience: googleConfig.clientId });
    expect(res.redirect).toHaveBeenCalledWith('/');
  });

  it('rejects a callback with no flow cookie (login CSRF)', async () => {
    const { state } = await startFlow();
    const res = await callback({ cookie: null, state });
    expect(res.redirect).toHaveBeenCalledWith('/?error=oauth_state');
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it('rejects a state that does not match the cookie', async () => {
    const { cookie } = await startFlow();
    const res = await callback({ cookie, state: 'attacker-chosen-state-value-xx' });
    expect(res.redirect).toHaveBeenCalledWith('/?error=oauth_state');
    expect(google.getToken).not.toHaveBeenCalled();
  });

  it('will not link or create an account from an unverified Google email', async () => {
    models.getUserByGoogleId.mockResolvedValue(null);
    models.getUserByEmail.mockResolvedValue({ id: 'victim', email: 'ada@example.com' });
    google.verifyIdToken.mockResolvedValue({
      getPayload: () => ({ sub: 'g-evil', email: 'ada@example.com', email_verified: false, name: 'Mallory' }),
    });
    const res = await callback(await startFlow());
    expect(res.redirect).toHaveBeenCalledWith('/?error=email_unverified');
    expect(models.updateGoogleId).not.toHaveBeenCalled();
    expect(models.createUserWithGoogle).not.toHaveBeenCalled();
  });
});
