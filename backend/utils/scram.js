/**
 * PostgreSQL SCRAM-SHA-256 password verifiers (RFC 5802, RFC 7677), the form
 * the server stores in pg_authid. Sending `ALTER ROLE ... PASSWORD '<verifier>'`
 * instead of the password keeps the password out of server logs and
 * pg_stat_activity; psql's \password does the same.
 */

import crypto from 'crypto';

const DEFAULT_ITERATIONS = 4096; // PostgreSQL's scram_iterations default
const SALT_LENGTH = 16;
// SASLprep leaves printable ASCII unchanged, so hashing it as-is matches the server.
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

const hmac = (key, text) => crypto.createHmac('sha256', key).update(text).digest();

/**
 * @param {string} password - printable ASCII
 * @param {object} [opts]
 * @param {Buffer} [opts.salt] - random 16 bytes by default
 * @param {number} [opts.iterations]
 * @returns {string} SCRAM-SHA-256$<iterations>:<salt>$<StoredKey>:<ServerKey>
 */
function scramSha256Verifier(
  password,
  { salt = crypto.randomBytes(SALT_LENGTH), iterations = DEFAULT_ITERATIONS } = {}
) {
  if (!PRINTABLE_ASCII.test(password)) throw new Error('The password must be printable ASCII');
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const storedKey = crypto.createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  const b64 = buf => buf.toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

export { scramSha256Verifier };
