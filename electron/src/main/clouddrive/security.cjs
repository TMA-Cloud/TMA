/*
 * Constant-time comparison of a presented bridge token against the session
 * token, so the comparison itself reveals nothing about how close a guess was.
 */
const crypto = require('crypto');

function tokenMatches(presented, expected) {
  if (!expected || typeof presented !== 'string') return false;
  // timingSafeEqual throws on a length mismatch (which would leak the length),
  // so hash both sides to a fixed width first.
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(Buffer.from(presented, 'utf8')).digest(),
    crypto.createHash('sha256').update(Buffer.from(expected, 'utf8')).digest()
  );
}

module.exports = { tokenMatches };
