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

export * from './auth/auth.signup.controller.js';
export * from './auth/auth.login.controller.js';
export * from './auth/auth.logout.controller.js';
export * from './auth/auth.profile.controller.js';
export * from './auth/auth.sessions.controller.js';
export * from './auth/auth.mfa.controller.js';
export * from './auth/auth.password.controller.js';
