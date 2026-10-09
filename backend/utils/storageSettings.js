/**
 * Object storage settings: validation, normalisation and at-rest encryption of
 * the secret access key. Pure apart from the KEK lookup, so tests cover it
 * directly.
 */

import { BlockList, isIP } from 'net';

import { kekForVersion, primaryKekVersion } from './fileEncryption.js';
import { openSettingSecret, sealSettingSecret } from './settingsSecret.js';

const STORAGE_PROVIDERS = ['s3', 'r2', 'aws'];
const DEFAULT_REGION = 'us-east-1';

const MAX_ENDPOINT_LENGTH = 2048;
const MAX_ACCESS_KEY_ID_LENGTH = 128;
const MAX_SECRET_LENGTH = 256;

const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const AWS_REGION_PATTERN = /^[a-z]{2}(?:-[a-z0-9]+)+-\d+$/;
// Printable ASCII without whitespace: every provider issues keys in this range.
const CREDENTIAL_PATTERN = /^[\x21-\x7e]+$/;

// Plain http is only acceptable where traffic never leaves a private network.
const PRIVATE_NETWORKS = new BlockList();
PRIVATE_NETWORKS.addSubnet('10.0.0.0', 8);
PRIVATE_NETWORKS.addSubnet('172.16.0.0', 12);
PRIVATE_NETWORKS.addSubnet('192.168.0.0', 16);
PRIVATE_NETWORKS.addSubnet('100.64.0.0', 10);
PRIVATE_NETWORKS.addSubnet('127.0.0.0', 8);
PRIVATE_NETWORKS.addAddress('::1', 'ipv6');
PRIVATE_NETWORKS.addSubnet('fc00::', 7, 'ipv6');

// Link-local holds cloud instance metadata (169.254.169.254); no storage endpoint lives there.
const FORBIDDEN_NETWORKS = new BlockList();
FORBIDDEN_NETWORKS.addSubnet('169.254.0.0', 16);
FORBIDDEN_NETWORKS.addSubnet('0.0.0.0', 8);
FORBIDDEN_NETWORKS.addSubnet('fe80::', 10, 'ipv6');
FORBIDDEN_NETWORKS.addAddress('::', 'ipv6');

const INTERNAL_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.localhost'];

// The access key ID is the binding, so a secret cannot be swapped onto another key's row.
const STORAGE_SECRET = {
  keyInfo: 'tma-cloud/storage-credentials/v1',
  aadPrefix: 'tma-cloud:storage-secret',
  label: 'storage secret',
};

class StorageSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StorageSettingsError';
    this.status = 400;
  }
}

function fail(message) {
  throw new StorageSettingsError(message);
}

function ipFamily(address) {
  return isIP(address) === 6 ? 'ipv6' : 'ipv4';
}

function isInternalHost(hostname) {
  if (isIP(hostname)) return PRIVATE_NETWORKS.check(hostname, ipFamily(hostname));
  return hostname === 'localhost' || !hostname.includes('.') || INTERNAL_SUFFIXES.some(s => hostname.endsWith(s));
}

/**
 * Validate an endpoint URL and reduce it to its origin. Credentials, paths and
 * query strings are rejected because the SDK would silently mis-sign or leak them.
 */
function normalizeEndpoint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) fail('Endpoint URL is required');
  if (raw.length > MAX_ENDPOINT_LENGTH) fail('Endpoint URL is too long');

  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    fail('Endpoint must be a valid URL, such as https://s3.example.com');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') fail('Endpoint must use https:// or http://');
  if (url.username || url.password) fail('Endpoint must not contain credentials');
  if (url.search || url.hash) fail('Endpoint must not contain a query string or fragment');
  if (url.pathname !== '/' && url.pathname !== '') fail('Endpoint must not contain a path; set the bucket separately');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(hostname) && FORBIDDEN_NETWORKS.check(hostname, ipFamily(hostname))) {
    fail('Endpoint points at a reserved address');
  }
  if (url.protocol === 'http:' && !isInternalHost(hostname)) {
    fail('Plain http:// is only allowed for private network addresses; use https:// for public endpoints');
  }
  return url.origin;
}

function normalizeBucket(raw) {
  const bucket = typeof raw === 'string' ? raw.trim() : '';
  if (!bucket) fail('Bucket name is required');
  if (
    !BUCKET_PATTERN.test(bucket) ||
    bucket.includes('..') ||
    isIP(bucket) ||
    bucket.startsWith('xn--') ||
    bucket.endsWith('-s3alias')
  ) {
    fail('Bucket name must be 3-63 lowercase letters, numbers, dots or hyphens, starting and ending alphanumerically');
  }
  return bucket;
}

function normalizeCredential(raw, label, maxLength) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) fail(`${label} is required`);
  if (value.length > maxLength || !CREDENTIAL_PATTERN.test(value)) fail(`${label} is not valid`);
  return value;
}

function normalizeRegion(raw, provider) {
  const region = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (provider === 'r2') return 'auto';
  if (provider === 'aws') {
    if (!AWS_REGION_PATTERN.test(region)) fail('AWS region is required, such as eu-west-1');
    return region;
  }
  if (!region) return DEFAULT_REGION;
  if (!REGION_PATTERN.test(region)) fail('Region may only contain lowercase letters, numbers and hyphens');
  return region;
}

/**
 * Turn admin input into the stored shape, reusing the saved credentials when
 * they are left blank so that editing the region does not need the secret again.
 * @param {object} input - Request body fields
 * @param {{ accessKeyId: string, secretAccessKey: string } | null} current - Saved credentials
 */
function normalizeStorageSettings(input, current = null) {
  const provider = input?.provider;
  if (!STORAGE_PROVIDERS.includes(provider)) fail(`Provider must be one of: ${STORAGE_PROVIDERS.join(', ')}`);

  const region = normalizeRegion(input.region, provider);
  const rawEndpoint = typeof input.endpoint === 'string' ? input.endpoint.trim() : '';
  const endpoint =
    provider === 'aws' && !rawEndpoint ? `https://s3.${region}.amazonaws.com` : normalizeEndpoint(rawEndpoint);

  let forcePathStyle = provider === 's3';
  if (provider === 's3' && input.forcePathStyle !== undefined) {
    if (typeof input.forcePathStyle !== 'boolean') fail('Path-style addressing must be true or false');
    forcePathStyle = input.forcePathStyle;
  }

  return {
    provider,
    endpoint,
    region,
    bucket: normalizeBucket(input.bucket),
    forcePathStyle,
    ...normalizeCredentials(input, current),
  };
}

// Blank credentials keep the saved pair, so the admin never has to see or re-type them.
function normalizeCredentials(input, current) {
  const isBlank = value => value === undefined || value === null || (typeof value === 'string' && !value.trim());
  const keyBlank = isBlank(input.accessKeyId);
  const secretBlank = isBlank(input.secretAccessKey);

  if (keyBlank && secretBlank && current) {
    return { accessKeyId: current.accessKeyId, secretAccessKey: current.secretAccessKey };
  }
  const accessKeyId = normalizeCredential(input.accessKeyId, 'Access key ID', MAX_ACCESS_KEY_ID_LENGTH);
  if (secretBlank) {
    if (current?.accessKeyId === accessKeyId) return { accessKeyId, secretAccessKey: current.secretAccessKey };
    fail('Secret access key is required');
  }
  return {
    accessKeyId,
    secretAccessKey: normalizeCredential(input.secretAccessKey, 'Secret access key', MAX_SECRET_LENGTH),
  };
}

/** True when two configurations address the same objects. */
function sameStorageTarget(a, b) {
  return Boolean(a && b && a.endpoint === b.endpoint && a.bucket === b.bucket);
}

function maskAccessKeyId(accessKeyId) {
  if (!accessKeyId) return null;
  return accessKeyId.length <= 8 ? '••••' : `${accessKeyId.slice(0, 4)}••••${accessKeyId.slice(-4)}`;
}

/** Encrypt a secret access key with AES-256-GCM under the given KEK. */
function sealSecret(secret, accessKeyId, kek) {
  return sealSettingSecret(secret, STORAGE_SECRET, accessKeyId, kek);
}

function openSecret(blob, accessKeyId, kek) {
  return openSettingSecret(blob, STORAGE_SECRET, accessKeyId, kek);
}

/** Encrypt under the current primary KEK. */
function encryptStorageSecret(secret, accessKeyId) {
  const kekVersion = primaryKekVersion();
  return { encrypted: sealSecret(secret, accessKeyId, kekForVersion(kekVersion)), kekVersion };
}

function decryptStorageSecret(encrypted, accessKeyId, kekVersion) {
  return openSecret(encrypted, accessKeyId, kekForVersion(kekVersion));
}

export {
  normalizeEndpoint,
  normalizeStorageSettings,
  sameStorageTarget,
  maskAccessKeyId,
  sealSecret,
  openSecret,
  encryptStorageSecret,
  decryptStorageSecret,
};
