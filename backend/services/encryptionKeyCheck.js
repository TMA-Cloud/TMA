/**
 * Startup guard for the master keys. A wrong FILE_ENCRYPTION_KEY used to let
 * the server start and then fail every download with "Error decrypting file";
 * this refuses to start instead, naming the key that is wrong.
 */

import { logger } from '../config/logger.js';
import { getKekChecks, kekVersionsInUse, recordKekCheck, sampleSealedUnderVersion } from '../models/kekCheck.model.js';
import { kekForVersion, primaryKekVersion, unwrapDek } from '../utils/fileEncryption.js';
import { kekCheckValue, matchesKekCheck } from '../utils/fileEncryption/keyCheck.js';
import { readKeyring } from '../utils/fileEncryption/keySource.js';
import { openGoogleSecret } from '../utils/googleAuthSettings.js';
import { openSecret } from '../utils/storageSettings.js';

class EncryptionKeyMismatchError extends Error {
  constructor(version) {
    super(
      `FILE_ENCRYPTION_KEY (key version ${version}) does not match the key this deployment's data was encrypted with. ` +
        'Restore the original key file or value.'
    );
    this.name = 'EncryptionKeyMismatchError';
  }
}

class EncryptionKeyMissingError extends Error {
  constructor(versions) {
    super(
      `Stored data is encrypted under key version ${versions.join(', ')}, which FILE_ENCRYPTION_KEY does not contain. ` +
        'Restore the key file that has every version.'
    );
    this.name = 'EncryptionKeyMissingError';
  }
}

// Before a version has a stored check, prove the key against data already sealed with it.
async function opensExistingData(version, kek) {
  const { dekWrapped, storageSecret, googleSecret } = await sampleSealedUnderVersion(version);
  try {
    if (dekWrapped) unwrapDek(Buffer.from(dekWrapped), kek);
    if (storageSecret) openSecret(storageSecret.encrypted, storageSecret.accessKeyId, kek);
    if (googleSecret) openGoogleSecret(googleSecret.encrypted, googleSecret.clientId, kek);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check every key in the keyring against its stored check value, recording a
 * check the first time a version is seen, and make sure no stored data needs a
 * version the keyring lacks.
 * @param {{ allowPassphrasePrimary?: boolean }} [opts] - for adding a random key on top of a passphrase
 * @throws {EncryptionKeyMismatchError | EncryptionKeyMissingError}
 */
async function verifyEncryptionKeys({ allowPassphrasePrimary = false } = {}) {
  const configured = readKeyring()?.keys.keys() ?? [primaryKekVersion()];
  const versions = [...configured].sort((a, b) => a - b);
  const [checks, inUse] = await Promise.all([getKekChecks(), kekVersionsInUse()]);

  const missing = inUse.filter(version => !versions.includes(version));
  if (missing.length) throw new EncryptionKeyMissingError(missing);

  for (const version of versions) {
    const kek = kekForVersion(version, { allowPassphrase: allowPassphrasePrimary });
    const stored = checks.get(version);
    if (stored) {
      if (!matchesKekCheck(kek, stored)) throw new EncryptionKeyMismatchError(version);
      continue;
    }
    if (!(await opensExistingData(version, kek))) throw new EncryptionKeyMismatchError(version);
    // Another process may record first; whichever value won must still match this key.
    const recorded = await recordKekCheck(version, kekCheckValue(kek));
    if (!matchesKekCheck(kek, recorded)) throw new EncryptionKeyMismatchError(version);
    logger.info({ version }, '[Encryption] Recorded key check value for master key version');
  }
}

const MISSING_TABLE = '42P01';

/**
 * Same check for a process that may start before the API has run migrations,
 * as the worker does on a fresh install: wait for the check table to appear
 * rather than skipping the check.
 */
async function verifyEncryptionKeysWhenReady({ attempts = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await verifyEncryptionKeys();
    } catch (err) {
      if (err.code !== MISSING_TABLE) throw err;
      if (attempt >= attempts) {
        logger.warn('[Encryption] Key check table still missing; the API verifies the master key on startup');
        return undefined;
      }
      await new Promise(resolve => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

export { verifyEncryptionKeys, verifyEncryptionKeysWhenReady };
