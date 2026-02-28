const crypto = require('crypto');
const fs = require('fs').promises;
const { createReadStream, createWriteStream } = require('fs');
const { pipeline } = require('stream/promises');
const { Transform, Readable } = require('stream');
const { logger } = require('../config/logger');

// AES-256-GCM configuration
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits for GCM
const TAG_LENGTH = 16; // 128 bits for authentication tag
const KEY_LENGTH = 32; // 256 bits

/**
 * Read exactly n bytes from a readable stream (consumes from stream; rest remains readable)
 * @param {import('stream').Readable} stream - Readable stream
 * @param {number} n - Number of bytes to read
 * @returns {Promise<Buffer>} First n bytes
 */
function readBytes(stream, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    function onReadable() {
      const chunk = stream.read();
      if (chunk) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= n) {
          const result = buf.subarray(0, n);
          const rest = buf.subarray(n);
          if (rest.length > 0) stream.unshift(rest);
          stream.removeListener('readable', onReadable);
          stream.removeListener('error', onError);
          stream.removeListener('end', onEnd);
          resolve(result);
        }
      }
    }
    function onError(err) {
      stream.removeListener('readable', onReadable);
      stream.removeListener('end', onEnd);
      reject(err);
    }
    function onEnd() {
      if (buf.length < n) {
        stream.removeListener('readable', onReadable);
        stream.removeListener('error', onError);
        reject(new Error('Invalid encrypted stream: too short for IV'));
      }
    }
    stream.on('readable', onReadable);
    stream.on('error', onError);
    stream.on('end', onEnd);
    onReadable();
  });
}

/**
 * Helper to create a Transform stream that appends auth tag at the end
 * @param {Object} cipher - Cipher object to get auth tag from
 * @returns {Transform} Transform stream
 */
function createAppendTagStream(cipher) {
  return new Transform({
    transform(chunk, encoding, cb) {
      cb(null, chunk); // Pass data through
    },
    flush(cb) {
      this.push(cipher.getAuthTag()); // Append tag when stream ends
      cb();
    },
  });
}

/**
 * Create a transform stream that encrypts plaintext input (for direct stream-to-S3 upload).
 * Output format: [IV][ENCRYPTED_DATA][TAG]
 * @returns {Transform} Transform stream (plaintext in -> encrypted out)
 */
function createEncryptStream() {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  return new Transform({
    transform(chunk, encoding, callback) {
      if (!this._ivPushed) {
        this._ivPushed = true;
        this.push(iv);
      }
      try {
        const out = cipher.update(chunk);
        if (out.length > 0) this.push(out);
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (!this._ivPushed) {
          this._ivPushed = true;
          this.push(iv);
        }
        const final = cipher.final();
        if (final.length > 0) this.push(final);
        this.push(cipher.getAuthTag());
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

/**
 * Create a transform stream that counts bytes passed through (for stream upload size).
 * @returns {{ stream: Transform, getByteCount: () => number }}
 */
function createByteCountStream() {
  let byteCount = 0;
  const stream = new Transform({
    transform(chunk, encoding, callback) {
      byteCount += chunk.length;
      callback(null, chunk);
    },
  });
  return {
    stream,
    getByteCount: () => byteCount,
  };
}

/**
 * Helper to read IV and TAG from encrypted file
 * File format: [IV][ENCRYPTED_DATA][TAG]
 * @param {string} encryptedPath - Path to encrypted file
 * @returns {Promise<{iv: Buffer, tag: Buffer, fileSize: number}>}
 */
async function readEncryptionMetadata(encryptedPath) {
  const fd = await fs.open(encryptedPath, 'r');
  const stats = await fd.stat();
  const fileSize = stats.size;

  if (fileSize < IV_LENGTH + TAG_LENGTH) {
    await fd.close();
    throw new Error('Invalid encrypted file format: file too small');
  }

  // Read IV from the beginning
  const ivBuffer = Buffer.alloc(IV_LENGTH);
  await fd.read(ivBuffer, 0, IV_LENGTH, 0);

  // Read TAG from the end
  const tagBuffer = Buffer.alloc(TAG_LENGTH);
  await fd.read(tagBuffer, 0, TAG_LENGTH, fileSize - TAG_LENGTH);

  await fd.close();

  return { iv: ivBuffer, tag: tagBuffer, fileSize };
}

/**
 * Get encryption key from environment variable or generate a default (for development only)
 * In production, FILE_ENCRYPTION_KEY should be set to a secure 32-byte key (base64 encoded)
 */
function getEncryptionKey() {
  const envKey = process.env.FILE_ENCRYPTION_KEY;
  if (envKey) {
    try {
      // If key is base64 encoded, decode it
      const decoded = Buffer.from(envKey, 'base64');
      if (decoded.length === KEY_LENGTH) {
        return decoded;
      }
      // If key is hex encoded, decode it
      if (envKey.length === KEY_LENGTH * 2) {
        return Buffer.from(envKey, 'hex');
      }
      // If key is a string, derive a key from it using PBKDF2
      return crypto.pbkdf2Sync(envKey, 'file-encryption-salt', 100000, KEY_LENGTH, 'sha256');
    } catch (error) {
      logger.error('[Encryption] Error processing encryption key from environment', error);
      throw new Error('Invalid encryption key format', { cause: error });
    }
  }

  // Development fallback - generate a deterministic key from a default value
  // WARNING: This is NOT secure for production!
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
 * Encrypt a file using streams (memory-efficient for large files)
 * @param {string} inputPath - Path to the file to encrypt
 * @param {string} outputPath - Path where encrypted file will be saved
 * @returns {Promise<void>}
 */
async function encryptFile(inputPath, outputPath) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const input = createReadStream(inputPath);
  const output = createWriteStream(outputPath);

  // Write IV first
  output.write(iv);

  // Helper stream to append Auth Tag at the end
  const appendTagStream = createAppendTagStream(cipher);

  // Pipeline handles flow control, backpressure, and errors automatically
  await pipeline(input, cipher, appendTagStream, output);

  // Remove original file
  await fs.unlink(inputPath);
}

/**
 * Decrypt a file using streams (memory-efficient for large files)
 * File format: [IV][ENCRYPTED_DATA][TAG]
 * @param {string} inputPath - Path to the encrypted file
 * @param {string} outputPath - Path where decrypted file will be saved
 * @returns {Promise<void>}
 */
async function decryptFile(inputPath, outputPath) {
  const key = getEncryptionKey();
  const { iv, tag, fileSize } = await readEncryptionMetadata(inputPath);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  // Stream encrypted data (excluding IV and TAG); empty file = no ciphertext bytes
  const ciphertextEnd = fileSize - TAG_LENGTH - 1; // inclusive
  const input =
    ciphertextEnd >= IV_LENGTH
      ? createReadStream(inputPath, { start: IV_LENGTH, end: ciphertextEnd })
      : Readable.from([Buffer.alloc(0)]);
  const output = createWriteStream(outputPath);

  // Stream decrypt: input -> decipher -> output
  await pipeline(input, decipher, output);
}

/**
 * Create a readable stream for decrypted file content
 * This is more memory-efficient for large files
 * File format: [IV][ENCRYPTED_DATA][TAG]
 * @param {string} encryptedPath - Path to the encrypted file
 * @returns {Promise<{stream: Readable, cleanup: Function}>}
 */
async function createDecryptStream(encryptedPath) {
  const key = getEncryptionKey();
  const { iv, tag, fileSize } = await readEncryptionMetadata(encryptedPath);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  // Create a transform stream that decrypts chunks
  const decryptTransform = new Transform({
    transform(chunk, encoding, callback) {
      try {
        // Decrypt the chunk - the decipher will verify the tag in final()
        const decrypted = decipher.update(chunk);
        if (decrypted.length > 0) {
          this.push(decrypted);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      try {
        // This will verify the authentication tag
        const final = decipher.final();
        if (final.length > 0) {
          this.push(final);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });

  // Start reading from after the IV, and stop before the TAG; empty file = no ciphertext bytes
  const ciphertextEnd = fileSize - TAG_LENGTH - 1; // inclusive
  const fileStream =
    ciphertextEnd >= IV_LENGTH
      ? createReadStream(encryptedPath, { start: IV_LENGTH, end: ciphertextEnd })
      : Readable.from([Buffer.alloc(0)]);

  // Use pipeline for proper backpressure handling and error propagation
  // But we need to return the stream, so we'll handle errors manually
  fileStream.on('error', err => {
    decryptTransform.destroy(err);
  });

  fileStream.pipe(decryptTransform);

  return {
    stream: decryptTransform,
    cleanup: () => {
      try {
        fileStream.destroy();
        decryptTransform.destroy();
      } catch (_err) {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Copy an encrypted file by decrypting and re-encrypting in a single pipeline
 * This avoids writing plaintext to disk (more secure and faster)
 * @param {string} sourceEncryptedPath - Path to source encrypted file
 * @param {string} destEncryptedPath - Path where new encrypted file will be saved
 * @returns {Promise<void>}
 */
async function copyEncryptedFile(sourceEncryptedPath, destEncryptedPath) {
  const key = getEncryptionKey();
  const { iv: sourceIv, tag: sourceTag, fileSize } = await readEncryptionMetadata(sourceEncryptedPath);

  // Create decipher for source
  const decipher = crypto.createDecipheriv(ALGORITHM, key, sourceIv);
  decipher.setAuthTag(sourceTag);

  // Create new IV and cipher for destination (ENCRYPT, not decrypt!)
  const destIv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, destIv);

  const ciphertextEnd = fileSize - TAG_LENGTH - 1; // inclusive
  const sourceStream =
    ciphertextEnd >= IV_LENGTH
      ? createReadStream(sourceEncryptedPath, { start: IV_LENGTH, end: ciphertextEnd })
      : Readable.from([Buffer.alloc(0)]);
  const destStream = createWriteStream(destEncryptedPath);

  // Write destination IV first
  destStream.write(destIv);

  // Helper stream to append Auth Tag at the end
  const appendTagStream = createAppendTagStream(cipher);

  // Pipeline: source(encrypted) -> decipher -> cipher -> appendTag -> dest(encrypted)
  // This processes data in chunks without ever storing plaintext on disk
  // Pipeline handles flow control, backpressure, and errors automatically
  await pipeline(sourceStream, decipher, cipher, appendTagStream, destStream);
}

/**
 * Create a decryption stream from an encrypted readable stream (for S3/object storage).
 * File format: [IV][ENCRYPTED_DATA][TAG]
 * @param {import('stream').Readable} encryptedStream - Readable stream of encrypted content
 * @returns {Promise<{stream: Transform, cleanup: Function}>}
 */
async function createDecryptStreamFromStream(encryptedStream) {
  const iv = await readBytes(encryptedStream, IV_LENGTH);
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  const bufferTagTransform = new Transform({
    transform(chunk, encoding, callback) {
      this._tail = Buffer.concat([this._tail || Buffer.alloc(0), chunk]);
      while (this._tail.length > TAG_LENGTH) {
        const out = this._tail.subarray(0, this._tail.length - TAG_LENGTH);
        this._tail = this._tail.subarray(this._tail.length - TAG_LENGTH);
        try {
          const dec = decipher.update(out);
          if (dec.length > 0) this.push(dec);
        } catch (err) {
          return callback(err);
        }
      }
      callback();
    },
    flush(callback) {
      try {
        decipher.setAuthTag(this._tail || Buffer.alloc(0));
        const final = decipher.final();
        if (final.length > 0) this.push(final);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });

  encryptedStream.on('error', err => bufferTagTransform.destroy(err));
  encryptedStream.pipe(bufferTagTransform);

  return {
    stream: bufferTagTransform,
    cleanup: () => {
      try {
        encryptedStream.destroy();
        bufferTagTransform.destroy();
      } catch (_err) {
        // Ignore
      }
    },
  };
}

/**
 * Copy encrypted content from a readable stream to a writable stream (decrypt then re-encrypt).
 * Used for S3 copy: source stream -> decrypt -> encrypt -> dest stream.
 * @param {import('stream').Readable} sourceEncryptedStream - Readable stream of encrypted content
 * @param {import('stream').Writable} destEncryptedStream - Writable stream for encrypted output
 * @returns {Promise<void>}
 */
async function copyEncryptedFileStreams(sourceEncryptedStream, destEncryptedStream) {
  const iv = await readBytes(sourceEncryptedStream, IV_LENGTH);
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);

  const destIv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, destIv);

  const bufferTagTransform = new Transform({
    transform(chunk, encoding, callback) {
      this._tail = Buffer.concat([this._tail || Buffer.alloc(0), chunk]);
      while (this._tail.length > TAG_LENGTH) {
        const out = this._tail.subarray(0, this._tail.length - TAG_LENGTH);
        this._tail = this._tail.subarray(this._tail.length - TAG_LENGTH);
        try {
          const dec = decipher.update(out);
          if (dec.length > 0) this.push(dec);
        } catch (err) {
          return callback(err);
        }
      }
      callback();
    },
    flush(callback) {
      try {
        decipher.setAuthTag(this._tail || Buffer.alloc(0));
        const final = decipher.final();
        if (final.length > 0) this.push(final);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });

  destEncryptedStream.write(destIv);
  const appendTagStream = createAppendTagStream(cipher);

  await pipeline(sourceEncryptedStream, bufferTagTransform, cipher, appendTagStream, destEncryptedStream);
}

/**
 * Check if a file is encrypted by checking its format
 * Encrypted files have IV + TAG + DATA structure
 * @param {string} filePath - Path to the file
 * @returns {Promise<boolean>}
 */
async function isFileEncrypted(filePath) {
  try {
    const stats = await fs.stat(filePath);
    // Encrypted files must be at least IV_LENGTH + TAG_LENGTH bytes
    if (stats.size < IV_LENGTH + TAG_LENGTH) {
      return false;
    }

    // Try to read and parse the file structure
    const buffer = await fs.readFile(filePath, { start: 0, end: IV_LENGTH + TAG_LENGTH - 1 });
    // If we can read the header, assume it's encrypted (simple heuristic)
    // In practice, we could add a magic number or check the database
    return buffer.length === IV_LENGTH + TAG_LENGTH;
  } catch (_error) {
    return false;
  }
}

module.exports = {
  encryptFile,
  decryptFile,
  createDecryptStream,
  createDecryptStreamFromStream,
  createEncryptStream,
  createByteCountStream,
  copyEncryptedFile,
  copyEncryptedFileStreams,
  isFileEncrypted,
};
