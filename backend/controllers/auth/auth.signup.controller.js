import bcrypt from 'bcryptjs';

import { logger } from '../../config/logger.js';
import { createUser, getUserByEmail, getSignupEnabled, handleFirstUserSetup } from '../../models/user.model.js';
import { loginFailure, userSignup } from '../../services/auditLogger.js';
import { createSessionAndToken, setAuthCookieAndRespond } from '../../utils/authSession.js';
import { sendError } from '../../utils/response.js';

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

    const existing = await getUserByEmail(email);
    if (existing) {
      await loginFailure(email, 'email_already_in_use', req);
      return sendError(res, 409, 'Email already in use');
    }

    const hashed = await bcrypt.hash(password, 10);
    const user = await createUser(email, hashed, name);

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

export { signup };
