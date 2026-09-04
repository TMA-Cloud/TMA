/**
 * Envelope encryption: per-file data keys (DEKs) wrapped by a versioned master
 * key-encryption-key (KEK).
 *
 * Every file's body is encrypted under its own random 32-byte DEK (used as the
 * streaming ikm, so the wire format in ./format.js is unchanged). The DEK is
 * then wrapped with the current KEK and stored next to the file's row. Rotating
 * the master key becomes "unwrap each DEK with the old KEK, rewrap with the new
 * one" — a small metadata update, never a re-encryption of the file bytes. That
 * is what makes rotation cheap at 50k–100k objects, especially on S3/R2 where
 * re-encrypting bodies means downloading and re-uploading every object.
 *
 * Envelope encryption is the only scheme: every encrypted file has a wrapped
 * DEK. A brand-new deployment starts that way; an existing one is brought there
 * once with scripts/backfill-envelope-encryption.js. resolveIkm() therefore
 * expects a wrapped DEK and treats its absence as an error rather than silently
 * decrypting under the master key.
 *
 * KEK registry (built from the environment, read lazily so tests/scripts can
 * swap keys in):
 *   - FILE_ENCRYPTION_KEY      the current (primary) KEK — same formats as ever.
 *   - FILE_KEK_VERSION         integer version of the primary KEK (default 1).
 *   - FILE_ENCRYPTION_KEY_V<n> older KEKs, kept only so their DEKs can still be
 *                              unwrapped until rotation to the new KEK finishes.
 * Wrapped DEK wire layout: iv(12) || AES-256-GCM(DEK)(32) || tag(16) = 60 bytes.
 */

import crypto from 'crypto';

import { deriveKeyFromRaw, getEncryptionKey } from './format.js';

const DEK_LENGTH = 32; // 256-bit per-file data key
const WRAP_IV_LENGTH = 12; // AES-GCM nonce for the wrap
const WRAP_TAG_LENGTH = 16;
const WRAPPED_DEK_LENGTH = WRAP_IV_LENGTH + DEK_LENGTH + WRAP_TAG_LENGTH; // 60
const KEK_VERSION_ENV_RE = /^FILE_ENCRYPTION_KEY_V(\d+)$/;

/** Version number of the primary (current) KEK. */
function primaryKekVersion() {
  const raw = parseInt(process.env.FILE_KEK_VERSION || '1', 10);
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(`Invalid FILE_KEK_VERSION: ${process.env.FILE_KEK_VERSION} (must be a positive integer)`);
  }
  return raw;
}

/**
 * Resolve a KEK by version from the environment. The primary version resolves
 * through getEncryptionKey() (so the dev fallback still applies); older versions
 * come from FILE_ENCRYPTION_KEY_V<n>.
 * @param {number} version
 * @returns {Buffer} 32-byte KEK
 */
function kekForVersion(version) {
  if (version === primaryKekVersion()) {
    return getEncryptionKey();
  }
  const raw = process.env[`FILE_ENCRYPTION_KEY_V${version}`];
  if (!raw) {
    throw new Error(
      `No KEK configured for version ${version}. Set FILE_ENCRYPTION_KEY_V${version} to the key that wrapped these DEKs.`
    );
  }
  return deriveKeyFromRaw(raw);
}

/** A fresh random per-file data key. */
function generateDek() {
  return crypto.randomBytes(DEK_LENGTH);
}

/**
 * Wrap a DEK with a KEK (AES-256-GCM).
 * @param {Buffer} dek - 32-byte data key
 * @param {Buffer} kek - 32-byte key-encryption key
 * @returns {Buffer} iv(12) || ciphertext(32) || tag(16)
 */
function wrapDek(dek, kek) {
  if (!Buffer.isBuffer(dek) || dek.length !== DEK_LENGTH) {
    throw new Error('wrapDek: DEK must be a 32-byte Buffer');
  }
  const iv = crypto.randomBytes(WRAP_IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  return Buffer.concat([iv, ciphertext, cipher.getAuthTag()]);
}

/**
 * Unwrap a DEK produced by wrapDek. Throws if the KEK is wrong or the blob was
 * tampered with (GCM tag failure).
 * @param {Buffer} wrapped - iv(12) || ciphertext(32) || tag(16)
 * @param {Buffer} kek - 32-byte key-encryption key
 * @returns {Buffer} 32-byte DEK
 */
function unwrapDek(wrapped, kek) {
  if (!Buffer.isBuffer(wrapped) || wrapped.length !== WRAPPED_DEK_LENGTH) {
    throw new Error(`unwrapDek: wrapped DEK must be ${WRAPPED_DEK_LENGTH} bytes`);
  }
  const iv = wrapped.subarray(0, WRAP_IV_LENGTH);
  const ciphertext = wrapped.subarray(WRAP_IV_LENGTH, WRAP_IV_LENGTH + DEK_LENGTH);
  const tag = wrapped.subarray(WRAP_IV_LENGTH + DEK_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Mint a new DEK and wrap it under the current primary KEK, for a fresh upload.
 * @returns {{ dek: Buffer, dekWrapped: Buffer, kekVersion: number }}
 */
function newWrappedDek() {
  const dek = generateDek();
  const kekVersion = primaryKekVersion();
  const dekWrapped = wrapDek(dek, kekForVersion(kekVersion));
  return { dek, dekWrapped, kekVersion };
}

/**
 * Rewrap an existing DEK from one KEK version to the current primary — the whole
 * of a key rotation for one file.
 * @param {Buffer} dekWrapped - DEK wrapped under `fromVersion`
 * @param {number} fromVersion - KEK version the DEK is currently wrapped under
 * @returns {{ dekWrapped: Buffer, kekVersion: number } | null} null when it is
 *   already wrapped under the primary KEK (nothing to do)
 */
function rewrapDekToPrimary(dekWrapped, fromVersion) {
  const target = primaryKekVersion();
  if (fromVersion === target) return null;
  const dek = unwrapDek(dekWrapped, kekForVersion(fromVersion));
  return { dekWrapped: wrapDek(dek, kekForVersion(target)), kekVersion: target };
}

/**
 * Resolve the streaming ikm for an encrypted file row by unwrapping its stored
 * DEK. Every encrypted file is expected to carry a wrapped DEK (run the backfill
 * on a pre-envelope deployment), so a missing DEK is an error, not a fallback.
 * @param {{ dekWrapped?: Buffer|null, dekKekVersion?: number|null }} row
 * @returns {Buffer} 32-byte ikm for the streaming decrypt/encrypt
 */
function resolveIkm(row) {
  const wrapped = row?.dekWrapped;
  if (wrapped == null) {
    throw new Error(
      'Encrypted file has no wrapped DEK. Run scripts/backfill-envelope-encryption.js to convert pre-envelope files.'
    );
  }
  const version = row?.dekKekVersion;
  if (version == null) {
    throw new Error('File has a wrapped DEK but no KEK version; cannot resolve its key.');
  }
  return unwrapDek(Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped), kekForVersion(version));
}

export {
  DEK_LENGTH,
  WRAPPED_DEK_LENGTH,
  KEK_VERSION_ENV_RE,
  primaryKekVersion,
  kekForVersion,
  generateDek,
  wrapDek,
  unwrapDek,
  newWrappedDek,
  rewrapDekToPrimary,
  resolveIkm,
};
