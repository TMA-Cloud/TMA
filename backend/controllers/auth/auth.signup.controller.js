const bcrypt = require('bcryptjs');
const { createUser, getUserByEmail, getSignupEnabled, handleFirstUserSetup } = require('../../models/user.model');
const { sendError } = require('../../utils/response');
const { validateString, validateEmail: validateEmailUtil } = require('../../utils/validation');
const { isValidPassword } = require('../../utils/auth');
const { logger } = require('../../config/logger');
const { loginFailure, userSignup } = require('../../services/auditLogger');
const { createSessionAndToken, setAuthCookieAndRespond } = require('../../utils/authSession');

// Align with frontend input limits
const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 100;

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

    if (typeof email !== 'string' || typeof password !== 'string') {
      return sendError(res, 400, 'Invalid email or password');
    }

    if (email.length > MAX_EMAIL_LENGTH) {
      await loginFailure(email, 'email_too_long', req);
      return sendError(res, 400, 'Email too long');
    }

    if (password.length > MAX_PASSWORD_LENGTH) {
      await loginFailure(email, 'password_too_long', req);
      return sendError(res, 400, 'Password too long');
    }

    // Validate email (validateEmailUtil already checks format and length)
    if (!validateEmailUtil(email)) {
      await loginFailure(email, 'invalid_email', req);
      return sendError(res, 400, 'Invalid email format');
    }

    // Validate password
    if (!isValidPassword(password)) {
      await loginFailure(email, 'weak_password', req);
      return sendError(res, 400, 'Password must be at least 6 characters');
    }

    // Name validation (if provided) - sanitize and limit length
    const validatedName = name ? validateString(name, MAX_NAME_LENGTH) : null;
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

    // Handle first user setup
    await handleFirstUserSetup(user.id);

    // Create session and generate token (new users start with token_version = 1)
    const { token } = await createSessionAndToken(user.id, req, 1);

    setAuthCookieAndRespond(res, token, { user });
  } catch (err) {
    sendError(res, 500, 'Server error', err);
  }
}

module.exports = {
  signup,
};
