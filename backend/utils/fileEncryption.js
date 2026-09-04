/**
 * File Encryption Index
 *
 * Segmented file encryption in Google Tink's AES-GCM-HKDF-STREAMING format
 * (AES256_GCM_HKDF_1MB). Split into focused modules; import paths and exported
 * names are unchanged so consumers (download range math, migration/rotation
 * scripts, tests) do not move:
 * - fileEncryption/format.js  - wire-format primitives, key derivation, layout math
 * - fileEncryption/streams.js - encrypt/decrypt Transform + Range-aware factories
 * - fileEncryption/fileOps.js - whole-file encrypt/decrypt/copy helpers
 */

export {
  createEncryptStream,
  createByteCountStream,
  createDecryptStream,
  createDecryptStreamFromStream,
  createRangeDecryptStream,
} from './fileEncryption/streams.js';
export { encryptFile, decryptFile, copyEncryptedFile, copyEncryptedFileStreams } from './fileEncryption/fileOps.js';
export {
  // Envelope encryption: per-file wrapped data keys + versioned KEK rotation
  DEK_LENGTH,
  WRAPPED_DEK_LENGTH,
  primaryKekVersion,
  kekForVersion,
  generateDek,
  wrapDek,
  unwrapDek,
  newWrappedDek,
  rewrapDekToPrimary,
  resolveIkm,
} from './fileEncryption/keyWrap.js';
export {
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
} from './fileEncryption/format.js';
