const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const {
  getUserByEmail,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
  getSignupEnabled,
  getMfaStatus,
} = require('../../models/user.model');
const { sendError } = require('../../utils/response');
const { validateEmail: validateEmailUtil } = require('../../utils/validation');
const { logger } = require('../../config/logger');
const { loginSuccess, loginFailure, userSignup } = require('../../services/auditLogger');
const { handleFirstUserSetup } = require('../../models/user.model');
const { createSessionAndToken, setAuthCookieAndRespond } = require('../../utils/authSession');
const { verifyMfaCode } = require('./auth.mfa.controller');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI;

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

    if (!email || !password) {
      return sendError(res, 400, 'Email and password required');
    }

    // Validate email (validateEmailUtil already checks format and length)
    if (!validateEmailUtil(email)) {
      await loginFailure(email, 'invalid_email', req);
      return sendError(res, 400, 'Invalid email format');
    }

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

    // Log successful login
    await loginSuccess(user.id, email, req);
    logger.info({ userId: user.id, email }, 'User logged in successfully');

    // Create session and generate token
    const { token } = await createSessionAndToken(user.id, req);

    setAuthCookieAndRespond(res, token, { user: { id: user.id, email: user.email, name: user.name } });
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
        await loginSuccess(user.id, email, req);
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
      await loginSuccess(user.id, email, req);
    }

    logger.info({ userId: user.id, email }, 'User authenticated via Google OAuth');

    // Check if MFA is enabled for Google OAuth users
    const mfaStatus = await getMfaStatus(user.id);
    if (mfaStatus?.enabled) {
      // For Google OAuth, we need to handle MFA differently
      // Since this is a redirect flow, we'll need to prompt for MFA code
      // For now, we'll require MFA code as a query parameter or handle it via session
      // This is a simplified approach - in production, you might want a two-step flow
      const { mfaCode } = req.query;
      if (!mfaCode) {
        // Redirect to MFA prompt page
        return res.redirect(`/?mfa_required=true&email=${encodeURIComponent(email)}`);
      }

      // Verify MFA code
      const mfaValid = await verifyMfaCode(user.id, mfaCode);
      if (!mfaValid) {
        return res.redirect('/?error=invalid_mfa_code');
      }
    }

    // Create session and generate token
    const { token } = await createSessionAndToken(user.id, req);

    res.cookie('token', token, require('../../utils/auth').getCookieOptions());
    res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'Google OAuth authentication failed');
    res.status(500).send('Authentication failed');
  }
}

module.exports = {
  login,
  googleLogin,
  googleCallback,
  googleAuthEnabled: !!GOOGLE_AUTH_ENABLED,
};
