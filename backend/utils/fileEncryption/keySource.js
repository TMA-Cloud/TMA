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

const VERSIONED_ENTRY = /^(\d+):(.+)$/;

const KEYRING_HEADER = [
  '# TMA Cloud file encryption keys, one "version:key" per line.',
  '# The highest version encrypts new data. Older lines decrypt data not yet',
  '# rewrapped and data in older backups, so keep them with those backups.',
];

/**
 * Parse a keyring: `version:key` entries separated by newlines or commas, with
 * `#` comment lines. A single entry without a version is version 1, so a plain
 * key from a fresh install is a keyring of one.
 * @param {string} text
 * @returns {Map<number, string>} raw key by version
 */
function parseKeyring(text) {
  const entries = text
    .split(/\r?\n/)
    .filter(line => !line.trim().startsWith('#'))
    .flatMap(line => line.split(','))
    .map(entry => entry.trim())
    .filter(Boolean);
  if (!entries.length) throw new Error('FILE_ENCRYPTION_KEY has no keys');
  if (entries.length === 1 && !VERSIONED_ENTRY.test(entries[0])) return new Map([[1, entries[0]]]);

  const keys = new Map();
  for (const entry of entries) {
    const match = VERSIONED_ENTRY.exec(entry);
    if (!match) throw new Error('FILE_ENCRYPTION_KEY lists several keys, so each needs a "version:" prefix');
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error(`FILE_ENCRYPTION_KEY has an invalid key version: ${match[1]}`);
    }
    if (keys.has(version)) throw new Error(`FILE_ENCRYPTION_KEY lists key version ${version} twice`);
    keys.set(version, match[2].trim());
  }
  return keys;
}

/** The highest version in a keyring: the one new data is encrypted under. */
function primaryVersionOf(keys) {
  return Math.max(...keys.keys());
}

/**
 * Serialise a keyring for FILE_ENCRYPTION_KEY_FILE, oldest first.
 * @param {Map<number, string>} keys
 */
function formatKeyring(keys) {
  const lines = [...keys].sort(([a], [b]) => a - b).map(([version, key]) => `${version}:${key}`);
  return [...KEYRING_HEADER, ...lines, ''].join('\n');
}

const parsedKeyrings = new Map();

/**
 * The configured keyring, or null when FILE_ENCRYPTION_KEY is unset.
 * @returns {{ keys: Map<number, string>, primary: number } | null}
 */
function readKeyring() {
  const raw = readSecret('FILE_ENCRYPTION_KEY');
  if (!raw) return null;
  if (!parsedKeyrings.has(raw)) {
    const keys = parseKeyring(raw);
    parsedKeyrings.set(raw, { keys, primary: primaryVersionOf(keys) });
  }
  return parsedKeyrings.get(raw);
}

export { readSecret, isRandomKey, generateKey, parseKeyring, primaryVersionOf, formatKeyring, readKeyring };
