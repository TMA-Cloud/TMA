const bcrypt = require('bcryptjs');
const { createUser, getUserByEmail, getSignupEnabled } = require('../../models/user.model');
const { createSession } = require('../../models/session.model');
const pool = require('../../config/db');
const { getCookieOptions, isValidEmail, isValidPassword, generateAuthToken } = require('../../utils/auth');
const { sendError, sendSuccess } = require('../../utils/response');
const { validateString, validateEmail: validateEmailUtil } = require('../../utils/validation');
const { logger } = require('../../config/logger');
const { loginFailure, userSignup } = require('../../services/auditLogger');
const { setSignupEnabled } = require('../../models/user.model');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  logger.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

/**
 * User signup
 */
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

module.exports = {
  signup,
};
