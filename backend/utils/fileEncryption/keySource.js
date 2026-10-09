/**
 * Where master keys come from: an environment variable, or a file named by
 * `<NAME>_FILE` (Docker and Kubernetes secrets). A file keeps the key out of
 * `docker inspect`, /proc/<pid>/environ and crash dumps that print the env.
 */

import crypto from 'crypto';
import fs from 'fs';

const KEY_LENGTH = 32;
const HEX_KEY = /^[0-9a-fA-F]{64}$/;
// Strict on purpose: Node's base64 decoder skips junk, so a passphrase can decode to 32 bytes.
const BASE64_KEY = /^[A-Za-z0-9+/]{43}=?$|^[A-Za-z0-9_-]{43}=?$/;

// Read once per path: the key is needed on every upload and download, and changing it needs a restart anyway.
const fileValues = new Map();

/**
 * Read a secret from `name` or from the file `${name}_FILE` points at.
 * @param {string} name - e.g. FILE_ENCRYPTION_KEY
 * @returns {string | undefined}
 */
function readSecret(name) {
  const direct = process.env[name];
  const filePath = process.env[`${name}_FILE`];
  if (direct && filePath) throw new Error(`Set either ${name} or ${name}_FILE, not both`);
  if (!filePath) return direct || undefined;

  if (!fileValues.has(filePath)) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read ${name}_FILE (${filePath}): ${err.code || err.message}`, { cause: err });
    }
    fileValues.set(filePath, content.trim());
  }
  const value = fileValues.get(filePath);
  if (!value) throw new Error(`${name}_FILE (${filePath}) is empty`);
  return value;
}

/** True when `raw` is a full-strength random key (64 hex chars, or base64 of 32 bytes) rather than a passphrase. */
function isRandomKey(raw) {
  if (HEX_KEY.test(raw)) return true;
  if (!BASE64_KEY.test(raw)) return false;
  return Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').length === KEY_LENGTH;
}

/** A new master key in the format the app expects. */
function generateKey() {
  return crypto.randomBytes(KEY_LENGTH).toString('base64');
}

/**
 * KEK versions with a key available: the primary plus every FILE_ENCRYPTION_KEY_V<n>
 * (or its _FILE form) present in the environment.
 * @param {number} primary
 * @returns {number[]}
 */
function configuredKeyVersions(primary) {
  const versions = new Set([primary]);
  for (const name of Object.keys(process.env)) {
    const match = /^FILE_ENCRYPTION_KEY_V(\d+)(?:_FILE)?$/.exec(name);
    if (match && process.env[name]) versions.add(Number(match[1]));
  }
  return [...versions].sort((a, b) => a - b);
}

export { readSecret, isRandomKey, generateKey, configuredKeyVersions };
