/**
 * Streaming layer: Transform/Readable factories that turn plaintext into the
 * segmented wire format and back, including the Range-aware partial decrypt.
 * All wire-format details live in ./format.js.
 */

import crypto from 'crypto';
import { Transform, Readable } from 'stream';

import {
  CIPHERTEXT_SEGMENT_SIZE,
  DERIVED_KEY_LENGTH,
  HEADER_LENGTH,
  NONCE_PREFIX_LENGTH,
  PLAINTEXT_FIRST_SEGMENT_MAX,
  PLAINTEXT_SEGMENT_MAX,
  TAG_LENGTH,
  buildHeader,
  ciphertextOffsetAt,
  ciphertextSegmentLength,
  collectStream,
  decryptSegment,
  deriveKey,
  encryptSegment,
  getEncryptionKey,
  parseHeader,
  plaintextOffsetAt,
  segmentIndexForOffset,
  totalSegments,
} from './format.js';

/**
 * Transform that encrypts plaintext into the streaming wire format. Buffers one
 * segment ahead so the final segment's nonce can be flagged as last.
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
        // Emit only when more data follows, so the remainder can become the last.
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
        // Final segment (an empty file yields a segment that is just the tag).
        this.push(encryptSegment(derivedKey, noncePrefix, segIndex, true, pending));
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Transform that decrypts a full stream in order, reading one segment ahead so
 * it can flag the final segment without knowing the plaintext length up front.
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

        // Emit any segment followed by more bytes (so it is not last).
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
 * Decrypt only the plaintext range [start, end] (inclusive), fetching just the
 * overlapping ciphertext segments — this is what serves an HTTP Range request
 * without reading the whole object.
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

export {
  createEncryptStream,
  createSequentialDecryptTransform,
  createByteCountStream,
  createDecryptStreamFromStream,
  createRangeDecryptStream,
};
