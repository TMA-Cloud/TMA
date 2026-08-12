import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

import { logger } from '../../config/logger.js';
import {
  createUserWithGoogle,
  getAccountContext,
  getMfaStatus,
  getSignupEnabled,
  getUserByEmail,
  getUserByGoogleId,
  handleFirstUserSetup,
  updateGoogleId,
} from '../../models/user.model.js';
import { loginFailure, loginSuccess, userSignup } from '../../services/auditLogger.js';
import { getCookieOptions } from '../../utils/auth.js';
import { ALL_PERMISSIONS } from '../../utils/permissions.js';
import { createSessionAndToken, setAuthCookieAndRespond } from '../../utils/authSession.js';
import { sendError } from '../../utils/response.js';

import { verifyMfaCode } from './auth.mfa.controller.js';

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

const JWT_SECRET = process.env.JWT_SECRET;
const GOOGLE_AUTH_ENABLED = GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI;
let googleClient;
if (GOOGLE_AUTH_ENABLED) {
  googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
} else {
  logger.info('Google OAuth disabled (missing credentials)');
}

if (!GOOGLE_AUTH_ENABLED) {
  logger.warn('Google OAuth credentials missing. Google login endpoints will be disabled.');
}

/**
 * User login with email and password
 */
async function login(req, res) {
  try {
    const { email, password, mfaCode } = req.body;

    const user = await getUserByEmail(email);
    if (!user) {
      await loginFailure(email, 'user_not_found', req);
      return sendError(res, 401, 'Invalid credentials');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      await loginFailure(email, 'invalid_password', req);
      return sendError(res, 401, 'Invalid credentials');
    }

    // Check if MFA is enabled
    const mfaStatus = await getMfaStatus(user.id);
    if (mfaStatus?.enabled) {
      // MFA is enabled - require MFA code
      if (!mfaCode || typeof mfaCode !== 'string') {
        return sendError(res, 400, 'MFA code required');
      }

      // Verify MFA code
      const mfaValid = await verifyMfaCode(user.id, mfaCode);
      if (!mfaValid) {
        await loginFailure(email, 'invalid_mfa_code', req);
        return sendError(res, 401, 'Invalid MFA code');
      }
    }

    // Log successful login, recording the account this identity belongs to so
    // a sub-user's login is attributable to the shared account it acts under.
    const account = await getAccountContext(user.id);
    await loginSuccess(user.id, email, req, account);
    logger.info({ userId: user.id, email, ownerId: account?.ownerId }, 'User logged in successfully');

    // Create session and generate token
    const { token } = await createSessionAndToken(user.id, req);

    setAuthCookieAndRespond(res, token, {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        created_at: user.created_at,
        mfa_enabled: user.mfa_enabled || false,
        isSubUser: Boolean(account?.isSubUser),
        permissions: account?.isSubUser ? account.permissions : ALL_PERMISSIONS,
      },
    });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Initiate Google OAuth login flow
 */
function googleLogin(req, res) {
  if (!GOOGLE_AUTH_ENABLED) {
    return res.status(503).send('Google OAuth disabled');
  }
  const url = googleClient.generateAuthUrl({
    scope: ['profile', 'email'],
    access_type: 'offline',
    prompt: 'consent',
  });
  res.redirect(url);
}

/**
 * Handle Google OAuth callback
 */
async function googleCallback(req, res) {
  try {
    if (!GOOGLE_AUTH_ENABLED) {
      return res.status(503).send('Google OAuth disabled');
    }
    const { code } = req.query;
    if (!code) return res.status(400).send('Missing code');

    const { tokens } = await googleClient.getToken(code);
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const googleId = payload.sub;
    const email = payload.email;
    const name = payload.name;

    let user = await getUserByGoogleId(googleId);
    if (!user) {
      user = await getUserByEmail(email);
      if (user) {
        // User exists by email - link Google account
        await updateGoogleId(user.id, googleId);
        await loginSuccess(user.id, email, req, await getAccountContext(user.id));
      } else {
        // User doesn't exist - create new account
        // Check if signup is enabled before creating new user
        const signupEnabled = await getSignupEnabled();
        if (!signupEnabled) {
          return res.redirect('/?error=signup_disabled');
        }
        user = await createUserWithGoogle(googleId, email, name);

        // Log signup
        await userSignup(user.id, email, 'google', req);

        // Handle first user setup
        await handleFirstUserSetup(user.id);
      }
    } else {
      // User found by Google ID - log login
      await loginSuccess(user.id, email, req, await getAccountContext(user.id));
    }

    logger.info({ userId: user.id, email }, 'User authenticated via Google OAuth');

    // Check if MFA is enabled for Google OAuth users
    const mfaStatus = await getMfaStatus(user.id);
    if (mfaStatus?.enabled) {
      // Use a short-lived signed cookie to carry MFA-pending state instead of
      // leaking the email in URL query parameters (browser history, Referer header, logs).
      const mfaPendingToken = jwt.sign({ userId: user.id, purpose: 'mfa_pending' }, JWT_SECRET, {
        expiresIn: '5m',
        algorithm: 'HS256',
      });

      res.cookie('mfa_pending', mfaPendingToken, {
        ...getCookieOptions(),
        maxAge: 5 * 60 * 1000, // 5 minutes
      });

      return res.redirect('/?mfa_required=true');
    }

    // Create session and generate token
    const { token } = await createSessionAndToken(user.id, req);

    res.cookie('token', token, getCookieOptions());
    res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'Google OAuth authentication failed');
    res.status(500).send('Authentication failed');
  }
}

/**
 * Complete Google OAuth MFA verification.
 * The frontend calls this with { mfaCode } after the user is redirected
 * back with ?mfa_required=true. The user's identity is carried in a
 * short-lived, HttpOnly `mfa_pending` cookie — never in the URL.
 */
async function googleMfaVerify(req, res) {
  try {
    const { mfaCode } = req.body;
    if (!mfaCode || typeof mfaCode !== 'string') {
      return sendError(res, 400, 'MFA code required');
    }

    // Read and validate the mfa_pending cookie (manual parse — no cookie-parser middleware)
    let pendingToken = null;
    if (req.headers.cookie) {
      const match = req.headers.cookie
        .split(';')
        .map(c => c.trim())
        .find(c => c.startsWith('mfa_pending='));
      if (match) pendingToken = match.split('=')[1];
    }
    if (!pendingToken) {
      return sendError(res, 401, 'MFA session expired or missing. Please sign in again.');
    }

    let decoded;
    try {
      decoded = jwt.verify(pendingToken, JWT_SECRET, { algorithms: ['HS256'] });
    } catch {
      // Clear the stale cookie
      res.clearCookie('mfa_pending', getCookieOptions());
      return sendError(res, 401, 'MFA session expired. Please sign in again.');
    }

    if (decoded.purpose !== 'mfa_pending' || !decoded.userId) {
      res.clearCookie('mfa_pending', getCookieOptions());
      return sendError(res, 401, 'Invalid MFA session');
    }

    // Verify the MFA code
    const mfaValid = await verifyMfaCode(decoded.userId, mfaCode);
    if (!mfaValid) {
      await loginFailure(decoded.userId, 'invalid_mfa_code', req);
      return sendError(res, 401, 'Invalid MFA code');
    }

    // MFA passed — clear the pending cookie and issue a real auth session
    res.clearCookie('mfa_pending', getCookieOptions());

    await loginSuccess(decoded.userId, null, req, await getAccountContext(decoded.userId));
    logger.info({ userId: decoded.userId }, 'Google OAuth MFA verification successful');

    const { token } = await createSessionAndToken(decoded.userId, req);

    setAuthCookieAndRespond(res, token, { success: true });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

const googleAuthEnabled = !!GOOGLE_AUTH_ENABLED;

export { login, googleLogin, googleCallback, googleMfaVerify, googleAuthEnabled };
