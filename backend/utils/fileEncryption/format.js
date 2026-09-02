/**
 * AES-GCM-HKDF-STREAMING wire format primitives (AES256_GCM_HKDF_1MB): the
 * master key, per-file key derivation, header build/parse, per-segment
 * seal/open, and the segment-layout math. Everything here is pure/stateless
 * (aside from reading the env key) and shared by the stream and file-op layers.
 *
 * Wire format:
 *   header    = headerLength(1) || salt(32) || noncePrefix(7)     // 40 bytes
 *   body      = segment_0 || segment_1 || ... || segment_n
 *   segment_i = AES256-GCM(derivedKey, nonce_i, plaintext_i) || tag(16)
 *   nonce_i   = noncePrefix(7) || uint32BE(i) || lastFlag(1)      // 12 bytes
 *   derivedKey = HKDF-SHA256(ikm = masterKey, salt, info = "")
 *
 * Segment 0's plaintext is shorter so header || segment_0 fills one segment;
 * later segments are exactly CIPHERTEXT_SEGMENT_SIZE (the last may be short),
 * which keeps the range math exact. Interoperable with Tink's StreamingAead.
 */

import crypto from 'crypto';

import { logger } from '../../config/logger.js';

// --- AES-GCM-HKDF-STREAMING parameters (AES256_GCM_HKDF_1MB) ---
const HKDF_HASH = 'sha256';
const KEY_LENGTH = 32; // master key (HKDF ikm), 256 bits
const DERIVED_KEY_LENGTH = 32; // per-file key, 256 bits
const TAG_LENGTH = 16; // AES-GCM tag, 128 bits
const NONCE_PREFIX_LENGTH = 7; // random per-file nonce prefix
const NONCE_LENGTH = 12; // prefix(7) + segment counter(4) + last-flag(1)
const HEADER_LENGTH = 1 + DERIVED_KEY_LENGTH + NONCE_PREFIX_LENGTH; // 40

// 1 MiB ciphertext segments (Tink's AES256_GCM_HKDF_1MB template).
const CIPHERTEXT_SEGMENT_SIZE = 1024 * 1024;

// Plaintext that fits in one ciphertext segment. The first segment shares its
// block with the header, so it holds a little less.
const PLAINTEXT_FIRST_SEGMENT_MAX = CIPHERTEXT_SEGMENT_SIZE - HEADER_LENGTH - TAG_LENGTH;
const PLAINTEXT_SEGMENT_MAX = CIPHERTEXT_SEGMENT_SIZE - TAG_LENGTH;

// Streaming AEAD feeds the associated data into HKDF as `info`, not into each
// GCM segment. We bind no associated data to stored files, so it is empty.
const ASSOCIATED_DATA = Buffer.alloc(0);

/**
 * Master key (HKDF ikm): a 32-byte base64/hex key, or a passphrase stretched
 * with PBKDF2. FILE_ENCRYPTION_KEY is required in production.
 * @returns {Buffer} 32-byte key
 */
function getEncryptionKey() {
  const envKey = process.env.FILE_ENCRYPTION_KEY;
  if (envKey) {
    try {
      const decoded = Buffer.from(envKey, 'base64');
      if (decoded.length === KEY_LENGTH) {
        return decoded;
      }
      if (envKey.length === KEY_LENGTH * 2 && /^[0-9a-fA-F]+$/.test(envKey)) {
        return Buffer.from(envKey, 'hex');
      }
      return crypto.pbkdf2Sync(envKey, 'file-encryption-salt', 100000, KEY_LENGTH, 'sha256');
    } catch (error) {
      logger.error('[Encryption] Error processing encryption key from environment', error);
      throw new Error('Invalid encryption key format', { cause: error });
    }
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'FILE_ENCRYPTION_KEY is required in production. Set a secure 32-byte key (base64 or hex encoded) in your environment.'
    );
  }

  logger.warn('[Encryption] FILE_ENCRYPTION_KEY not set, using development default key');
  return crypto.pbkdf2Sync(
    'development-key-change-in-production',
    'file-encryption-salt',
    100000,
    KEY_LENGTH,
    'sha256'
  );
}

/**
 * Derive the per-file key from the master key and the file's random salt.
 * @param {Buffer} ikm - Master key
 * @param {Buffer} salt - Per-file salt from the header
 * @returns {Buffer} 32-byte derived key
 */
function deriveKey(ikm, salt) {
  return Buffer.from(crypto.hkdfSync(HKDF_HASH, ikm, salt, ASSOCIATED_DATA, DERIVED_KEY_LENGTH));
}

/**
 * Build the 40-byte header: headerLength(1) || salt(32) || noncePrefix(7).
 */
function buildHeader(salt, noncePrefix) {
  const header = Buffer.alloc(HEADER_LENGTH);
  header[0] = HEADER_LENGTH;
  salt.copy(header, 1);
  noncePrefix.copy(header, 1 + DERIVED_KEY_LENGTH);
  return header;
}

/**
 * Parse a 40-byte header into its salt and nonce prefix.
 * @param {Buffer} buf - Buffer holding at least HEADER_LENGTH bytes
 * @returns {{ salt: Buffer, noncePrefix: Buffer }}
 */
function parseHeader(buf) {
  if (!buf || buf.length < HEADER_LENGTH) {
    throw new Error('Invalid encrypted stream: header too short');
  }
  const headerLen = buf[0];
  if (headerLen !== HEADER_LENGTH) {
    throw new Error(`Unsupported encryption header length: ${headerLen}`);
  }
  const salt = buf.subarray(1, 1 + DERIVED_KEY_LENGTH);
  const noncePrefix = buf.subarray(1 + DERIVED_KEY_LENGTH, HEADER_LENGTH);
  return { salt, noncePrefix };
}

/**
 * Compose the 12-byte GCM nonce for a segment.
 * nonce = noncePrefix(7) || uint32BE(index) || lastFlag(1)
 */
function segmentNonce(noncePrefix, index, isLast) {
  const nonce = Buffer.alloc(NONCE_LENGTH);
  noncePrefix.copy(nonce, 0);
  nonce.writeUInt32BE(index >>> 0, NONCE_PREFIX_LENGTH);
  nonce[NONCE_PREFIX_LENGTH + 4] = isLast ? 1 : 0;
  return nonce;
}

/**
 * Seal one plaintext segment.
 * @returns {Buffer} ciphertext || tag
 */
function encryptSegment(derivedKey, noncePrefix, index, isLast, plaintextSeg) {
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, segmentNonce(noncePrefix, index, isLast));
  const body = Buffer.concat([cipher.update(plaintextSeg), cipher.final()]);
  return Buffer.concat([body, cipher.getAuthTag()]);
}

/**
 * Open one ciphertext segment (ciphertext || tag), verifying its GCM tag.
 * @returns {Buffer} plaintext
 */
function decryptSegment(derivedKey, noncePrefix, index, isLast, ctWithTag) {
  if (ctWithTag.length < TAG_LENGTH) {
    throw new Error('Invalid encrypted segment: shorter than the authentication tag');
  }
  const body = ctWithTag.subarray(0, ctWithTag.length - TAG_LENGTH);
  const tag = ctWithTag.subarray(ctWithTag.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, segmentNonce(noncePrefix, index, isLast));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// --- Segment layout math (all derived from the plaintext length) ---

/** Total number of segments a plaintext of `length` bytes is split into. */
function totalSegments(length) {
  if (length <= PLAINTEXT_FIRST_SEGMENT_MAX) return 1;
  return 1 + Math.ceil((length - PLAINTEXT_FIRST_SEGMENT_MAX) / PLAINTEXT_SEGMENT_MAX);
}

/** Plaintext byte offset at which segment `i` begins. */
function plaintextOffsetAt(i) {
  if (i <= 0) return 0;
  return PLAINTEXT_FIRST_SEGMENT_MAX + (i - 1) * PLAINTEXT_SEGMENT_MAX;
}

/** Plaintext length of segment `i` for a file of `length` bytes. */
function plaintextSegmentLength(i, length) {
  const total = totalSegments(length);
  if (i < 0 || i >= total) return 0;
  if (i < total - 1) return i === 0 ? PLAINTEXT_FIRST_SEGMENT_MAX : PLAINTEXT_SEGMENT_MAX;
  return length - plaintextOffsetAt(i);
}

/** Ciphertext byte offset at which segment `i` begins. */
function ciphertextOffsetAt(i) {
  if (i <= 0) return HEADER_LENGTH;
  return i * CIPHERTEXT_SEGMENT_SIZE;
}

/** Ciphertext length (including tag) of segment `i` for a file of `length` bytes. */
function ciphertextSegmentLength(i, length) {
  return plaintextSegmentLength(i, length) + TAG_LENGTH;
}

/** Index of the segment that contains plaintext byte offset `p`. */
function segmentIndexForOffset(p) {
  if (p < PLAINTEXT_FIRST_SEGMENT_MAX) return 0;
  return 1 + Math.floor((p - PLAINTEXT_FIRST_SEGMENT_MAX) / PLAINTEXT_SEGMENT_MAX);
}

/**
 * Recover the plaintext length from the total ciphertext size. The layout is a
 * bijection, so this is exact — no need to store the size separately.
 * @param {number} ciphertextSize - Total stored object size in bytes
 * @returns {number} Plaintext length in bytes
 */
function ciphertextSizeToPlaintextSize(ciphertextSize) {
  const C = Number(ciphertextSize);
  if (!Number.isFinite(C) || C < HEADER_LENGTH + TAG_LENGTH) {
    throw new Error(`Invalid ciphertext size: ${ciphertextSize}`);
  }
  const body = C - HEADER_LENGTH;
  const firstCiphertextCap = CIPHERTEXT_SEGMENT_SIZE - HEADER_LENGTH;
  if (body <= firstCiphertextCap) {
    return body - TAG_LENGTH; // single segment
  }
  const rem = body - firstCiphertextCap;
  const fullMiddle = Math.floor(rem / CIPHERTEXT_SEGMENT_SIZE);
  const lastCiphertext = rem - fullMiddle * CIPHERTEXT_SEGMENT_SIZE;
  const base = PLAINTEXT_FIRST_SEGMENT_MAX + fullMiddle * PLAINTEXT_SEGMENT_MAX;
  return lastCiphertext === 0 ? base : base + (lastCiphertext - TAG_LENGTH);
}

/**
 * Read exactly `n` bytes from a readable stream (for the fixed-size header).
 */
async function collectStream(stream, n) {
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = Buffer.concat([buf, chunk]);
    if (n != null && buf.length >= n) break;
  }
  if (n != null && buf.length < n) {
    throw new Error('Invalid encrypted stream: ended before the header was complete');
  }
  return n != null ? buf.subarray(0, n) : buf;
}

export {
  // Constants
  DERIVED_KEY_LENGTH,
  TAG_LENGTH,
  NONCE_PREFIX_LENGTH,
  HEADER_LENGTH,
  CIPHERTEXT_SEGMENT_SIZE,
  PLAINTEXT_FIRST_SEGMENT_MAX,
  PLAINTEXT_SEGMENT_MAX,
  // Key + header
  getEncryptionKey,
  deriveKey,
  buildHeader,
  parseHeader,
  // Per-segment seal/open
  encryptSegment,
  decryptSegment,
  // Segment layout math
  totalSegments,
  plaintextOffsetAt,
  plaintextSegmentLength,
  ciphertextOffsetAt,
  ciphertextSegmentLength,
  segmentIndexForOffset,
  ciphertextSizeToPlaintextSize,
  // Stream helper
  collectStream,
};
