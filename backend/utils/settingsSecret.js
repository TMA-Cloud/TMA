/**
 * AES-256-GCM sealing for secrets kept in app_settings (the bucket secret, the
 * Google client secret). Pure apart from the inputs, so tests cover it directly.
 *
 * Each purpose gets its own HKDF subkey of the master key, so these ciphertexts
 * stay cryptographically separate from file key wraps and from each other. The
 * AAD binds a secret to the identifier stored beside it, so a secret cannot be
 * moved onto another row or another key ID and still decrypt.
 */

import crypto from 'crypto';

const FORMAT_VERSION = 1;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * @typedef {{ keyInfo: string, aadPrefix: string, label: string }} SecretPurpose
 */

function subkey(kek, purpose) {
  return Buffer.from(crypto.hkdfSync('sha256', kek, Buffer.alloc(0), Buffer.from(purpose.keyInfo), 32));
}

function aad(purpose, binding) {
  return Buffer.from(`${purpose.aadPrefix}:${binding}`, 'utf8');
}

/**
 * Layout: format(1) || iv(12) || ciphertext || tag(16).
 * @param {string} secret
 * @param {SecretPurpose} purpose
 * @param {string} binding - The identifier stored next to the secret
 * @param {Buffer} kek
 */
function sealSettingSecret(secret, purpose, binding, kek) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey(kek, purpose), iv);
  cipher.setAAD(aad(purpose, binding));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, ciphertext, cipher.getAuthTag()]);
}

function openSettingSecret(blob, purpose, binding, kek) {
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buffer.length <= 1 + IV_LENGTH + TAG_LENGTH || buffer[0] !== FORMAT_VERSION) {
    throw new Error(`Stored ${purpose.label} has an unknown format`);
  }
  const iv = buffer.subarray(1, 1 + IV_LENGTH);
  const tag = buffer.subarray(buffer.length - TAG_LENGTH);
  const ciphertext = buffer.subarray(1 + IV_LENGTH, buffer.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey(kek, purpose), iv);
  decipher.setAAD(aad(purpose, binding));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export { sealSettingSecret, openSettingSecret };
