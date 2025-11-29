const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
  getSignupEnabled,
  setSignupEnabled
} = require('../models/user.model');
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

const GOOGLE_AUTH_ENABLED =
  GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && GOOGLE_REDIRECT_URI;
let googleClient;
if (GOOGLE_AUTH_ENABLED) {
  googleClient = new OAuth2Client(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );
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
      } catch (err) {
        await client.query('ROLLBACK');
        // If first_user_id already set, just disable signup
        await setSignupEnabled(false, user.id);
      } finally {
        client.release();
      }
    }

    const token = generateAuthToken(user.id, JWT_SECRET);
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

    const token = generateAuthToken(user.id, JWT_SECRET);
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
    prompt: 'consent'
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
      audience: GOOGLE_CLIENT_ID
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
          } catch (err) {
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
    const token = generateAuthToken(user.id, JWT_SECRET);
    res.cookie('token', token, getCookieOptions());
    res.redirect('/');
  } catch (err) {
    logger.error({ err }, 'Google OAuth authentication failed');
    res.status(500).send('Authentication failed');
  }
}

async function logout(req, res) {
  try {
    // Log logout event (userId available from auth middleware via req.userId)
    if (req.userId) {
      const { logAuditEvent } = require('../services/auditLogger');
      await logAuditEvent('auth.logout', { status: 'success', resourceType: 'auth' }, req);
      logger.info({ userId: req.userId }, 'User logged out');
    }

    res.clearCookie('token');
    res.json({ message: 'Logged out' });
  } catch (err) {
    logger.error({ err }, 'Logout error');
    res.clearCookie('token');
    res.json({ message: 'Logged out' });
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

module.exports = {
  signup,
  login,
  googleLogin,
  googleCallback,
  logout,
  profile,
  googleAuthEnabled: !!GOOGLE_AUTH_ENABLED
};
