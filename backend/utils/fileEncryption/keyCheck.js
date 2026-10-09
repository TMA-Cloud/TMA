/**
 * Key check values: prove a process holds the same master key as before
 * without storing anything that reveals it. The check is an HMAC of a fixed
 * label under a subkey of the KEK, the MAC-based KCV construction used for AES keys.
 */

import crypto from 'crypto';

const CHECK_INFO = Buffer.from('tma-cloud/kek-check/v1');
const CHECK_LABEL = 'tma-cloud key check';

/** @param {Buffer} kek - 32-byte master key */
function kekCheckValue(kek) {
  const subkey = Buffer.from(crypto.hkdfSync('sha256', kek, Buffer.alloc(0), CHECK_INFO, 32));
  return crypto.createHmac('sha256', subkey).update(CHECK_LABEL).digest();
}

function matchesKekCheck(kek, stored) {
  const expected = kekCheckValue(kek);
  const actual = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export { kekCheckValue, matchesKekCheck };
