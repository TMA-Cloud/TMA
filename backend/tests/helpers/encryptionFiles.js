/** Temporary-file adapters used only by encryption tests. */
import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import { getEncryptionKey } from '../../utils/fileEncryption/format.js';
import { createEncryptStream, createSequentialDecryptTransform } from '../../utils/fileEncryption/streams.js';

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
 * Copy an encrypted file on disk by decrypting and re-encrypting through a
 * pipeline, so plaintext is never written to disk and the copy gets a fresh
 * salt/nonce prefix. With envelope encryption the copy is re-encrypted under
 * its own key, so pass `encryptIkm` (the destination's DEK) distinct from
 * `decryptIkm` (the source's).
 * @param {string} sourceEncryptedPath
 * @param {string} destEncryptedPath
 * @param {Buffer} [decryptIkm] - Key the source was encrypted under
 * @param {Buffer} [encryptIkm] - Key to encrypt the copy under (defaults to decryptIkm)
 */
async function copyEncryptedFile(
  sourceEncryptedPath,
  destEncryptedPath,
  decryptIkm = getEncryptionKey(),
  encryptIkm = decryptIkm
) {
  await pipeline(
    createReadStream(sourceEncryptedPath),
    createSequentialDecryptTransform(decryptIkm),
    createEncryptStream(encryptIkm),
    createWriteStream(destEncryptedPath)
  );
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

export { encryptFile, decryptFile, copyEncryptedFile, createDecryptStream };
