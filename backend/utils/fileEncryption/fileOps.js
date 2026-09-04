/**
 * Whole-file helpers: encrypt/decrypt a file on disk and copy an encrypted file
 * (decrypt then re-encrypt so plaintext never touches disk and the copy gets a
 * fresh salt/nonce prefix). Built on the streaming layer in ./streams.js.
 */

import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

import { getEncryptionKey } from './format.js';
import { createEncryptStream, createSequentialDecryptTransform } from './streams.js';

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
 * Copy encrypted content between streams (decrypt then re-encrypt) for S3 copies.
 * @param {import('stream').Readable} sourceEncryptedStream
 * @param {import('stream').Writable} destEncryptedStream
 * @param {Buffer} [decryptIkm] - Key the source was encrypted under
 * @param {Buffer} [encryptIkm] - Key to encrypt the copy under (defaults to decryptIkm)
 */
async function copyEncryptedFileStreams(
  sourceEncryptedStream,
  destEncryptedStream,
  decryptIkm = getEncryptionKey(),
  encryptIkm = decryptIkm
) {
  await pipeline(
    sourceEncryptedStream,
    createSequentialDecryptTransform(decryptIkm),
    createEncryptStream(encryptIkm),
    destEncryptedStream
  );
}

export { encryptFile, decryptFile, copyEncryptedFile, copyEncryptedFileStreams };
