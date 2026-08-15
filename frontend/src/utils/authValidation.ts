/**
 * Client-side checks for the sign-in and sign-up forms.
 *
 * These exist to catch obvious mistakes before a request goes out, not to
 * secure anything: the server validates every field again and is the only
 * decision that counts. Anyone can skip this file with a `curl`, so it must
 * never be the reason a rule holds.
 *
 * The limits below mirror the server's schema so the two agree on what is
 * acceptable; a field the client waves through and the server rejects reaches
 * the user as an unhelpful "Validation failed".
 */

export const MAX_EMAIL_LENGTH = 254;
export const MAX_PASSWORD_LENGTH = 128;
export const MAX_NAME_LENGTH = 100;

// Matches MIN_PASSWORD_LENGTH in the server's validationSchemas.js.
export const MIN_PASSWORD_LENGTH = 8;

// Deliberately loose. Precise email grammar is not decidable with a regular
// expression, and a form that argues with a valid address. This catches
// typing nothing, typing a username, or leaving off the domain.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Returns a message describing the problem, or null when the value is fine. */
export const validateEmail = (email: string): string | null => {
  const trimmed = email.trim();
  if (!trimmed) return 'Enter your email address';
  if (trimmed.length > MAX_EMAIL_LENGTH) return `Email must not exceed ${MAX_EMAIL_LENGTH} characters`;
  if (!EMAIL_PATTERN.test(trimmed)) return 'Enter a valid email address, like you@example.com';
  return null;
};

/**
 * Sign-in checks presence and nothing else. Length or composition rules at
 * this point would lock out anyone whose password predates the current policy,
 * and they leak what the policy is to someone guessing at accounts.
 */
export const validateLoginPassword = (password: string): string | null => {
  if (!password) return 'Enter your password';
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`;
  return null;
};

/** Used wherever a password is *set*: signing up, changing one, or creating a sub-user. */
export const validateNewPassword = (password: string): string | null => {
  if (!password) return 'Choose a password';
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must not exceed ${MAX_PASSWORD_LENGTH} characters`;
  return null;
};

export const validateName = (name: string): string | null => {
  const trimmed = name.trim();
  if (!trimmed) return 'Enter your name';
  if (trimmed.length > MAX_NAME_LENGTH) return `Name must not exceed ${MAX_NAME_LENGTH} characters`;
  return null;
};

/** A TOTP code is 6 digits and a backup code is 8 characters. */
export const validateMfaCode = (code: string): string | null => {
  const trimmed = code.trim();
  if (!trimmed) return 'Enter your MFA code';
  if (trimmed.length < 6) return 'Codes are 6 digits, or 8 characters for a backup code';
  return null;
};
