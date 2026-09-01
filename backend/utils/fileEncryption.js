/**
 * Segmented file encryption in Google Tink's AES-GCM-HKDF-STREAMING format
 * (AES256_GCM_HKDF_1MB). Splitting the file into independently-sealed segments
 * makes it seekable — a download can serve an HTTP range by decrypting only the
 * overlapping segments.
 *
 * Wire format:
 *   header    = headerLength(1) || salt(32) || noncePrefix(7)     // 40 bytes
 *   body      = segment_0 || segment_1 || ... || segment_n
 *   segment_i = AES256-GCM(derivedKey, nonce_i, plaintext_i) || tag(16)
 *   nonce_i   = noncePrefix(7) || uint32BE(i) || lastFlag(1)      // 12 bytes
 *   derivedKey = HKDF-SHA256(ikm = masterKey, salt, info = "")
 *
 * Segment 0's plaintext is shorter so header || segment_0 fills one
 * CIPHERTEXT_SEGMENT_SIZE block; later ciphertext segments are exactly
 * CIPHERTEXT_SEGMENT_SIZE (the last may be short), which keeps the range offset
 * math exact. Interoperable with Tink's StreamingAead.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';

import { logger } from '../config/logger.js';

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
 * Get the master encryption key (HKDF input keying material).
 * Accepts a 32-byte base64 key, a 64-char hex key, or any passphrase (stretched
 * with PBKDF2). In production FILE_ENCRYPTION_KEY must be set.
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
 * Recover the plaintext length from the total ciphertext (object) size.
 * The layout is a bijection, so this is exact — no need to store the size
 * separately for range math.
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

/**
 * Transform that encrypts plaintext into the streaming wire format.
 * Buffers just enough to know which segment is last (so its nonce flag is set),
 * emitting each earlier segment as soon as more data proves it is not the last.
 * @param {Buffer} [ikm] - Master key (defaults to the configured key)
 * @returns {Transform}
 */
function createEncryptStream(ikm = getEncryptionKey()) {
  const salt = crypto.randomBytes(DERIVED_KEY_LENGTH);
  const noncePrefix = crypto.randomBytes(NONCE_PREFIX_LENGTH);
  const derivedKey = deriveKey(ikm, salt);
  const header = buildHeader(salt, noncePrefix);

  let headerPushed = false;
  let segIndex = 0;
  let pending = Buffer.alloc(0);

  const segmentCap = () => (segIndex === 0 ? PLAINTEXT_FIRST_SEGMENT_MAX : PLAINTEXT_SEGMENT_MAX);

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        if (!headerPushed) {
          this.push(header);
          headerPushed = true;
        }
        pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
        // Emit a segment only when strictly more data follows, so the buffered
        // remainder is always available to become the final (flagged) segment.
        while (pending.length > segmentCap()) {
          const cap = segmentCap();
          const seg = pending.subarray(0, cap);
          pending = pending.subarray(cap);
          this.push(encryptSegment(derivedKey, noncePrefix, segIndex, false, seg));
          segIndex += 1;
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (!headerPushed) {
          this.push(header);
          headerPushed = true;
        }
        // Final segment (marked last). For an empty file this is a zero-length
        // plaintext, producing a segment that is just the tag.
        this.push(encryptSegment(derivedKey, noncePrefix, segIndex, true, pending));
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Transform that decrypts a full stream in the streaming wire format, in order.
 * Reads one segment ahead so it can flag the final segment correctly without
 * knowing the plaintext length up front.
 * @param {Buffer} [ikm] - Master key
 * @returns {Transform}
 */
function createSequentialDecryptTransform(ikm = getEncryptionKey()) {
  let headerParsed = false;
  let derivedKey = null;
  let noncePrefix = null;
  let buf = Buffer.alloc(0);
  let segIndex = 0;

  const currentCiphertextCap = () =>
    segIndex === 0 ? CIPHERTEXT_SEGMENT_SIZE - HEADER_LENGTH : CIPHERTEXT_SEGMENT_SIZE;

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);

        if (!headerParsed) {
          if (buf.length < HEADER_LENGTH) return callback();
          const { salt, noncePrefix: np } = parseHeader(buf);
          derivedKey = deriveKey(ikm, salt);
          noncePrefix = np;
          headerParsed = true;
          buf = buf.subarray(HEADER_LENGTH);
        }

        // Emit any segment strictly followed by more bytes (so it is not last).
        while (buf.length > currentCiphertextCap()) {
          const cap = currentCiphertextCap();
          const ct = buf.subarray(0, cap);
          buf = buf.subarray(cap);
          this.push(decryptSegment(derivedKey, noncePrefix, segIndex, false, ct));
          segIndex += 1;
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (!headerParsed) {
          return callback(new Error('Invalid encrypted stream: missing header'));
        }
        if (buf.length < TAG_LENGTH) {
          return callback(new Error('Invalid encrypted stream: truncated final segment'));
        }
        this.push(decryptSegment(derivedKey, noncePrefix, segIndex, true, buf));
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a byte-counting passthrough (used to learn an upload's encrypted size).
 * @returns {{ stream: Transform, getByteCount: () => number }}
 */
function createByteCountStream() {
  let byteCount = 0;
  const stream = new Transform({
    transform(chunk, _encoding, callback) {
      byteCount += chunk.length;
      callback(null, chunk);
    },
  });
  return { stream, getByteCount: () => byteCount };
}

/**
 * Encrypt a file on disk (plaintext -> streaming ciphertext), removing the input.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Buffer} [ikm]
 */
async function encryptFile(inputPath, outputPath, ikm = getEncryptionKey()) {
  await pipeline(createReadStream(inputPath), createEncryptStream(ikm), createWriteStream(outputPath));
  await fs.unlink(inputPath);
}

/**
 * Decrypt an encrypted file on disk to a plaintext file.
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {Buffer} [ikm]
 */
async function decryptFile(inputPath, outputPath, ikm = getEncryptionKey()) {
  await pipeline(createReadStream(inputPath), createSequentialDecryptTransform(ikm), createWriteStream(outputPath));
}

/**
 * Full-file decrypt stream from a local encrypted file.
 * @param {string} encryptedPath
 * @param {Buffer} [ikm]
 * @returns {Promise<{ stream: Transform, cleanup: Function }>}
 */
async function createDecryptStream(encryptedPath, ikm = getEncryptionKey()) {
  const fileStream = createReadStream(encryptedPath);
  const decrypt = createSequentialDecryptTransform(ikm);
  fileStream.on('error', err => decrypt.destroy(err));
  fileStream.pipe(decrypt);
  return {
    stream: decrypt,
    cleanup: () => {
      try {
        fileStream.destroy();
        decrypt.destroy();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Full-file decrypt stream from an already-open encrypted readable stream (S3).
 * @param {import('stream').Readable} encryptedStream
 * @param {Buffer} [ikm]
 * @returns {Promise<{ stream: Transform, cleanup: Function }>}
 */
async function createDecryptStreamFromStream(encryptedStream, ikm = getEncryptionKey()) {
  const decrypt = createSequentialDecryptTransform(ikm);
  encryptedStream.on('error', err => decrypt.destroy(err));
  encryptedStream.pipe(decrypt);
  return {
    stream: decrypt,
    cleanup: () => {
      try {
        encryptedStream.destroy();
        decrypt.destroy();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Decrypt only the plaintext byte range [start, end] (inclusive), fetching just
 * the ciphertext segments that overlap it. This is what lets a download satisfy
 * an HTTP Range request without reading the whole object.
 *
 * @param {Object} params
 * @param {(startInclusive: number, endInclusive: number) => Promise<import('stream').Readable>} params.readRange
 *   Returns a readable of the object's ciphertext bytes in [start, end].
 * @param {number} params.plaintextSize - Full plaintext length of the file
 * @param {number} params.start - First plaintext byte to return (inclusive)
 * @param {number} params.end - Last plaintext byte to return (inclusive)
 * @param {Buffer} [params.ikm] - Master key
 * @returns {Promise<{ stream: Readable, cleanup: Function }>}
 */
async function createRangeDecryptStream({ readRange, plaintextSize, start, end, ikm = getEncryptionKey() }) {
  const header = await collectStream(await readRange(0, HEADER_LENGTH - 1), HEADER_LENGTH);
  const { salt, noncePrefix } = parseHeader(header);
  const derivedKey = deriveKey(ikm, salt);

  const total = totalSegments(plaintextSize);
  const firstSeg = segmentIndexForOffset(start);
  const lastSeg = segmentIndexForOffset(end);

  const ctStart = ciphertextOffsetAt(firstSeg);
  const ctEnd = ciphertextOffsetAt(lastSeg) + ciphertextSegmentLength(lastSeg, plaintextSize) - 1;
  const frontTrim = start - plaintextOffsetAt(firstSeg);
  const wanted = end - start + 1;

  const ciphertextStream = await readRange(ctStart, ctEnd);

  async function* decryptRange() {
    let pending = Buffer.alloc(0);
    let seg = firstSeg;
    let emitted = 0;

    for await (const chunk of ciphertextStream) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (seg <= lastSeg) {
        const need = ciphertextSegmentLength(seg, plaintextSize);
        if (pending.length < need) break;
        const ct = pending.subarray(0, need);
        pending = pending.subarray(need);

        let pt = decryptSegment(derivedKey, noncePrefix, seg, seg === total - 1, ct);
        if (seg === firstSeg && frontTrim > 0) pt = pt.subarray(frontTrim);
        if (emitted + pt.length > wanted) pt = pt.subarray(0, wanted - emitted);
        emitted += pt.length;
        seg += 1;

        if (pt.length > 0) yield pt;
        if (emitted >= wanted) return;
      }
    }
  }

  const stream = Readable.from(decryptRange());
  return {
    stream,
    cleanup: () => {
      try {
        ciphertextStream.destroy();
        stream.destroy();
      } catch {
        // ignore
      }
    },
  };
}

/**
 * Copy an encrypted file on disk by decrypting and re-encrypting through a
 * pipeline, so plaintext is never written to disk and the copy gets a fresh
 * salt/nonce prefix.
 * @param {string} sourceEncryptedPath
 * @param {string} destEncryptedPath
 * @param {Buffer} [ikm]
 */
async function copyEncryptedFile(sourceEncryptedPath, destEncryptedPath, ikm = getEncryptionKey()) {
  await pipeline(
    createReadStream(sourceEncryptedPath),
    createSequentialDecryptTransform(ikm),
    createEncryptStream(ikm),
    createWriteStream(destEncryptedPath)
  );
}

/**
 * Copy encrypted content between streams (decrypt then re-encrypt) for S3 copies.
 * @param {import('stream').Readable} sourceEncryptedStream
 * @param {import('stream').Writable} destEncryptedStream
 * @param {Buffer} [ikm]
 */
async function copyEncryptedFileStreams(sourceEncryptedStream, destEncryptedStream, ikm = getEncryptionKey()) {
  await pipeline(
    sourceEncryptedStream,
    createSequentialDecryptTransform(ikm),
    createEncryptStream(ikm),
    destEncryptedStream
  );
}

export {
  // Streaming primitives
  createEncryptStream,
  createByteCountStream,
  createDecryptStream,
  createDecryptStreamFromStream,
  createRangeDecryptStream,
  // Whole-file helpers
  encryptFile,
  decryptFile,
  copyEncryptedFile,
  copyEncryptedFileStreams,
  // Key + layout helpers (used by download range math and migration/rotation scripts)
  getEncryptionKey,
  ciphertextSizeToPlaintextSize,
  // Format constants (exported for scripts and tests)
  HEADER_LENGTH,
  TAG_LENGTH,
  CIPHERTEXT_SEGMENT_SIZE,
  DERIVED_KEY_LENGTH,
  PLAINTEXT_FIRST_SEGMENT_MAX,
  PLAINTEXT_SEGMENT_MAX,
};
