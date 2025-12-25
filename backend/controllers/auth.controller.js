const bcrypt = require('bcryptjs');
const { OAuth2Client } = require('google-auth-library');
const {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
  getSignupEnabled,
  setSignupEnabled,
  getUserTokenVersion,
  invalidateAllSessions,
} = require('../models/user.model');
const { createSession, deleteAllUserSessions, getActiveSessions, deleteSession } = require('../models/session.model');
const pool = require('../config/db');
const { getCookieOptions, isValidEmail, isValidPassword, generateAuthToken } = require('../utils/auth');
const { sendError, sendSuccess } = require('../utils/response');
const { validateString, validateEmail: validateEmailUtil } = require('../utils/validation');
const { logger } = require('../config/logger');
const { loginSuccess, loginFailure, userSignup } = require('../services/auditLogger');

const JWT_SECRET = process.env.JWT_SECRET;
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

if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

if (!GOOGLE_AUTH_ENABLED) {
  logger.warn('Google OAuth credentials missing. Google login endpoints will be disabled.');
}

async function signup(req, res) {
  try {
    // Check if signup is enabled
    const signupEnabled = await getSignupEnabled();
    if (!signupEnabled) {
      return sendError(res, 403, 'Signup is currently disabled');
    }

    const { email, password, name } = req.body;

    // Input validation
    if (!email || !password) {
      return sendError(res, 400, 'Email and password required');
    }

    // Validate and sanitize email
    if (!validateEmailUtil(email) || !isValidEmail(email)) {
      await loginFailure(email, 'invalid_email', req);
      return sendError(res, 400, 'Invalid email format');
    }

    // Validate password
    if (!isValidPassword(password)) {
      await loginFailure(email, 'weak_password', req);
      return sendError(res, 400, 'Password must be at least 6 characters');
    }

    // Name validation (if provided) - sanitize and limit length
    const validatedName = name ? validateString(name, 255) : null;
    if (name && !validatedName) {
      return sendError(res, 400, 'Invalid name');
    }

    const existing = await getUserByEmail(email);
    if (existing) {
      await loginFailure(email, 'email_already_in_use', req);
      return sendError(res, 409, 'Email already in use');
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await createUser(email, hashed, validatedName);

    // Log signup success
    await userSignup(user.id, email, 'password', req);
    logger.info({ userId: user.id, email }, 'User signed up successfully');

    // After first user signs up, disable signup by default and lock first_user_id
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count, 10);
    if (userCount === 1) {
      // This is the first user, set first_user_id and disable signup atomically
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Set first_user_id (immutable after this)
        await client.query(
          'UPDATE app_settings SET first_user_id = $1, signup_enabled = false, updated_at = NOW() WHERE id = $2 AND first_user_id IS NULL',
          [user.id, 'app_settings']
        );

        await client.query('COMMIT');
        logger.info({ userId: user.id }, 'First user created, signup disabled by default');
      } catch (_err) {
        await client.query('ROLLBACK');
        // If first_user_id already set, just disable signup
        await setSignupEnabled(false, user.id);
      } finally {
        client.release();
      }
    }

    // New users start with token_version = 1
    // Create session record first to get session ID
    const ipAddress = req?.ip || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const session = await createSession(user.id, 1, userAgent, ipAddress);

    // Generate token with session ID bound to it
    const token = generateAuthToken(user.id, JWT_SECRET, { tokenVersion: 1, sessionId: session.id, req });

    res.cookie('token', token, getCookieOptions());
    sendSuccess(res, { user });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return sendError(res, 400, 'Email and password required');
    }

    // Validate and sanitize email
    if (!validateEmailUtil(email) || !isValidEmail(email)) {
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

    // Log successful login
    await loginSuccess(user.id, email, req);
    logger.info({ userId: user.id, email }, 'User logged in successfully');

    // Get current token version for the user
    const tokenVersion = (await getUserTokenVersion(user.id)) || 1;

    // Create session record first to get session ID
    const ipAddress = req?.ip || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const session = await createSession(user.id, tokenVersion, userAgent, ipAddress);

    // Generate token with session ID bound to it
    const token = generateAuthToken(user.id, JWT_SECRET, { tokenVersion, sessionId: session.id, req });

    res.cookie('token', token, getCookieOptions());
    sendSuccess(res, { user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

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

        // After first user signs up, disable signup by default and lock first_user_id
        const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
        const userCount = parseInt(userCountResult.rows[0].count, 10);
        if (userCount === 1) {
          // This is the first user, set first_user_id and disable signup atomically
          const client = await pool.connect();
          try {
            await client.query('BEGIN');

            // Set first_user_id (immutable after this)
            await client.query(
              'UPDATE app_settings SET first_user_id = $1, signup_enabled = false, updated_at = NOW() WHERE id = $2 AND first_user_id IS NULL',
              [user.id, 'app_settings']
            );

            await client.query('COMMIT');
            logger.info({ userId: user.id }, 'First user created via Google, signup disabled by default');
          } catch (_err) {
            await client.query('ROLLBACK');
            // If first_user_id already set, just disable signup
            await setSignupEnabled(false, user.id);
          } finally {
            client.release();
          }
        }
      }
    } else {
      // User found by Google ID - log login
      await loginSuccess(user.id, email, req);
    }

    logger.info({ userId: user.id, email }, 'User authenticated via Google OAuth');
    // Get current token version for the user
    const tokenVersion = (await getUserTokenVersion(user.id)) || 1;

    // Create session record first to get session ID
    const ipAddress = req?.ip || req?.socket?.remoteAddress || null;
    const userAgent = req?.headers?.['user-agent'] || null;
    const session = await createSession(user.id, tokenVersion, userAgent, ipAddress);

    // Generate token with session ID bound to it
    const token = generateAuthToken(user.id, JWT_SECRET, { tokenVersion, sessionId: session.id, req });

    res.cookie('token', token, getCookieOptions());
    res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'Google OAuth authentication failed');
    res.status(500).send('Authentication failed');
  }
}

async function logout(req, res) {
  try {
    let userId = req.userId || null;
    let sessionId = null;

    // Try to get userId and sessionId from token (logout may not use authMiddleware)
    try {
      const jwt = require('jsonwebtoken');
      let token;
      if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const t = cookies.find(c => c.startsWith('token='));
        if (t) token = t.slice('token='.length);
      }
      if (!token && req.headers.authorization) {
        token = req.headers.authorization.split(' ')[1];
      }

      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        userId = decoded.id || userId;
        sessionId = decoded.sid || null;
      }
    } catch (err) {
      // If token decode fails, continue without session ID (token might be expired/invalid)
      logger.debug({ err }, 'Could not decode token during logout');
    }

    // Revoke the current session if session ID is available
    if (sessionId && userId) {
      try {
        const deleted = await deleteSession(sessionId, userId);
        if (deleted) {
          logger.info({ userId, sessionId }, 'Session revoked on logout');
        }
      } catch (err) {
        // Log error but don't fail logout if session deletion fails
        logger.warn({ err, userId, sessionId }, 'Failed to revoke session on logout');
      }
    }

    // Log logout event
    if (userId) {
      const { logAuditEvent } = require('../services/auditLogger');
      await logAuditEvent(
        'auth.logout',
        {
          status: 'success',
          resourceType: 'auth',
          resourceId: sessionId || null,
          details: sessionId ? 'User logged out and session revoked' : 'User logged out',
        },
        req
      );
      logger.info({ userId, sessionId }, 'User logged out');
    }

    res.clearCookie('token');
    res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
  }
}

/**
 * Logout from all devices by invalidating all tokens
 * This increments the user's token_version, making all existing tokens invalid
 */
async function logoutAllDevices(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    // Invalidate all sessions
    const newTokenVersion = await invalidateAllSessions(req.userId);

    // Delete all session records
    await deleteAllUserSessions(req.userId);

    // Log the security event
    const { logAuditEvent } = require('../services/auditLogger');
    await logAuditEvent(
      'auth.logout_all',
      {
        status: 'success',
        resourceType: 'auth',
        details: 'User invalidated all active sessions',
      },
      req
    );
    logger.info({ userId: req.userId, newTokenVersion }, 'User logged out from all devices');

    // Clear the current session cookie
    res.clearCookie('token');

    sendSuccess(res, {
      message: 'Successfully logged out from all devices',
      sessionsInvalidated: true,
    });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Logout all devices error');
    sendError(res, 500, 'Failed to logout from all devices', err);
  }
}

async function profile(req, res) {
  try {
    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'Not found');
    }
    sendSuccess(res, user);
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

/**
 * Get all active sessions for the current user
 */
async function getSessions(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    const user = await getUserById(req.userId);
    if (!user) {
      return sendError(res, 404, 'User not found');
    }

    // Get session ID from token to identify current session
    let currentSessionId = null;
    try {
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET;
      let token;
      if (req.headers.cookie) {
        const cookies = req.headers.cookie.split(';').map(c => c.trim());
        const t = cookies.find(c => c.startsWith('token='));
        if (t) token = t.slice('token='.length);
      }
      if (!token && req.headers.authorization) {
        token = req.headers.authorization.split(' ')[1];
      }
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
        currentSessionId = decoded.sid || null;
      }
    } catch (err) {
      // If token decode fails, continue without current session ID
      logger.debug({ err }, 'Could not decode token to get current session ID');
    }

    const currentTokenVersion = user.token_version || 1;
    const sessions = await getActiveSessions(req.userId, currentTokenVersion);

    // Mark which session is the current one
    const sessionsWithCurrent = sessions.map(session => ({
      ...session,
      isCurrent: session.id === currentSessionId,
    }));

    sendSuccess(res, { sessions: sessionsWithCurrent });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to get sessions');
    sendError(res, 500, 'Failed to get sessions', err);
  }
}

/**
 * Revoke a specific session
 */
async function revokeSession(req, res) {
  try {
    if (!req.userId) {
      return sendError(res, 401, 'Not authenticated');
    }

    const { sessionId } = req.params;
    if (!sessionId) {
      return sendError(res, 400, 'Session ID required');
    }

    const deleted = await deleteSession(sessionId, req.userId);
    if (!deleted) {
      return sendError(res, 404, 'Session not found');
    }

    // Log the security event
    const { logAuditEvent } = require('../services/auditLogger');
    await logAuditEvent(
      'auth.session_revoked',
      {
        status: 'success',
        resourceType: 'auth',
        resourceId: sessionId,
        details: 'User revoked a specific session',
      },
      req
    );

    logger.info({ userId: req.userId, sessionId }, 'User revoked a session');
    sendSuccess(res, { message: 'Session revoked successfully' });
  } catch (err) {
    logger.error({ err, userId: req.userId }, 'Failed to revoke session');
    sendError(res, 500, 'Failed to revoke session', err);
  }
}

module.exports = {
  signup,
  login,
  googleLogin,
  googleCallback,
  logout,
  logoutAllDevices,
  profile,
  getSessions,
  revokeSession,
  googleAuthEnabled: !!GOOGLE_AUTH_ENABLED,
};
