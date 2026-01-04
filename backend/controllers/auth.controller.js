/**
 * Auth Controller Index
 *
 * This file re-exports all auth controllers for backward compatibility.
 * The controllers have been split into smaller, more maintainable modules:
 * - auth.signup.controller.js - User signup
 * - auth.login.controller.js - Login operations (password and Google OAuth)
 * - auth.logout.controller.js - Logout operations (single and all devices)
 * - auth.profile.controller.js - User profile operations
 * - auth.sessions.controller.js - Session management
 * - auth.mfa.controller.js - MFA operations (setup, enable, disable, verify)
 */

const signupControllers = require('./auth/auth.signup.controller');
const loginControllers = require('./auth/auth.login.controller');
const logoutControllers = require('./auth/auth.logout.controller');
const profileControllers = require('./auth/auth.profile.controller');
const sessionsControllers = require('./auth/auth.sessions.controller');
const mfaControllers = require('./auth/auth.mfa.controller');

module.exports = {
  ...signupControllers,
  ...loginControllers,
  ...logoutControllers,
  ...profileControllers,
  ...sessionsControllers,
  ...mfaControllers,
};
