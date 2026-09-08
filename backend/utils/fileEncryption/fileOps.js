/** Stream encrypted content between bucket objects under independent keys. */
import { pipeline } from 'stream/promises';
import { getEncryptionKey } from './format.js';
import { createEncryptStream, createSequentialDecryptTransform } from './streams.js';

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

export { copyEncryptedFileStreams };
