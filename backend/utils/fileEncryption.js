/**
 * File Encryption Index
 *
 * Segmented file encryption in Google Tink's AES-GCM-HKDF-STREAMING format
 * (AES256_GCM_HKDF_1MB). Split into focused modules; import paths and exported
 * names are unchanged so consumers (download range math, the rotation script,
 * tests) do not move:
 * - fileEncryption/format.js  - wire-format primitives, key derivation, layout math
 * - fileEncryption/streams.js - encrypt/decrypt Transform + Range-aware factories
 */

export {
  createEncryptStream,
  createByteCountStream,
  createDecryptStreamFromStream,
  createRangeDecryptStream,
} from './fileEncryption/streams.js';
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
  // Key + layout helpers (used by download range math, the rotation script and tests)
  getEncryptionKey,
  ciphertextSizeToPlaintextSize,
  plaintextSizeToCiphertextSize,
  // Format constants (exported for scripts and tests)
  HEADER_LENGTH,
  TAG_LENGTH,
  PLAINTEXT_FIRST_SEGMENT_MAX,
  PLAINTEXT_SEGMENT_MAX,
} from './fileEncryption/format.js';
