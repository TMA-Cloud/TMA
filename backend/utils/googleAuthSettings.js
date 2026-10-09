/**
 * Google sign-in settings: validation of the OAuth client the first user enters,
 * and at-rest encryption of the client secret. Pure apart from the KEK lookup,
 * so tests cover it directly.
 */

import { isIP } from 'net';

import { kekForVersion, primaryKekVersion } from './fileEncryption.js';
import { openSettingSecret, sealSettingSecret } from './settingsSecret.js';

/** The route that finishes the flow; Google must send users back to exactly this path. */
const GOOGLE_CALLBACK_PATH = '/api/google/callback';

const CLIENT_ID_PATTERN = /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/;
const MAX_CLIENT_ID_LENGTH = 255;
// Printable ASCII without whitespace, as Google issues them (GOCSPX-…).
const CLIENT_SECRET_PATTERN = /^[\x21-\x7e]{8,256}$/;
const MAX_REDIRECT_URI_LENGTH = 2048;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

// The client ID is the binding, so a secret cannot be moved onto another client's row.
const GOOGLE_SECRET = {
  keyInfo: 'tma-cloud/google-oauth/v1',
  aadPrefix: 'tma-cloud:google-client-secret',
  label: 'Google client secret',
};

class GoogleAuthSettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleAuthSettingsError';
    this.status = 400;
  }
}

function fail(message) {
  throw new GoogleAuthSettingsError(message);
}

const isBlank = value => value === undefined || value === null || (typeof value === 'string' && !value.trim());

function normalizeClientId(raw) {
  const clientId = typeof raw === 'string' ? raw.trim() : '';
  if (!clientId) fail('Client ID is required');
  if (clientId.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_PATTERN.test(clientId)) {
    fail('Client ID must look like 123456789-abc123.apps.googleusercontent.com');
  }
  return clientId;
}

function normalizeClientSecret(raw) {
  const secret = typeof raw === 'string' ? raw.trim() : '';
  if (!CLIENT_SECRET_PATTERN.test(secret)) fail('Client secret is not valid');
  return secret;
}

/**
 * The callback URL on this server, held to the rules Google applies to
 * redirect URIs, so a value Google would refuse is caught here instead of at
 * sign-in: https (http only on localhost), no raw IP outside loopback, no
 * credentials, query or fragment, and exactly the callback path.
 */
function normalizeRedirectUri(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) fail('Redirect URI is required');
  if (value.length > MAX_REDIRECT_URI_LENGTH) fail('Redirect URI is too long');

  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`Redirect URI must be a full URL, such as https://cloud.example.com${GOOGLE_CALLBACK_PATH}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const loopback = LOOPBACK_HOSTS.has(hostname);

  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    fail('Redirect URI must use https:// (http:// is allowed only for localhost)');
  }
  if (url.username || url.password) fail('Redirect URI must not contain credentials');
  if (url.search || url.hash) fail('Redirect URI must not contain a query string or fragment');
  if (isIP(hostname) && !loopback) fail('Google does not accept an IP address in a redirect URI; use a domain name');
  if (!loopback && !hostname.includes('.')) fail('Redirect URI must use a public domain name');
  if (url.pathname !== GOOGLE_CALLBACK_PATH) fail(`Redirect URI must end with ${GOOGLE_CALLBACK_PATH}`);

  return `${url.origin}${GOOGLE_CALLBACK_PATH}`;
}

/**
 * Turn admin input into the stored shape. A blank secret keeps the saved one
 * while the client ID stays the same, so editing the redirect URI does not
 * need the secret again.
 * @param {object} input - Request body fields
 * @param {{ clientId: string, clientSecret: string } | null} current - Saved settings
 */
function normalizeGoogleAuthSettings(input, current = null) {
  const clientId = normalizeClientId(input?.clientId);
  let clientSecret;
  if (isBlank(input?.clientSecret)) {
    if (current?.clientId !== clientId) fail('Client secret is required');
    clientSecret = current.clientSecret;
  } else {
    clientSecret = normalizeClientSecret(input.clientSecret);
  }
  return { clientId, clientSecret, redirectUri: normalizeRedirectUri(input?.redirectUri) };
}

function sealGoogleSecret(secret, clientId, kek) {
  return sealSettingSecret(secret, GOOGLE_SECRET, clientId, kek);
}

function openGoogleSecret(blob, clientId, kek) {
  return openSettingSecret(blob, GOOGLE_SECRET, clientId, kek);
}

/** Encrypt under the current primary KEK. */
function encryptGoogleSecret(secret, clientId) {
  const kekVersion = primaryKekVersion();
  return { encrypted: sealGoogleSecret(secret, clientId, kekForVersion(kekVersion)), kekVersion };
}

function decryptGoogleSecret(encrypted, clientId, kekVersion) {
  return openGoogleSecret(encrypted, clientId, kekForVersion(kekVersion));
}

export {
  GoogleAuthSettingsError,
  normalizeGoogleAuthSettings,
  normalizeRedirectUri,
  openGoogleSecret,
  encryptGoogleSecret,
  decryptGoogleSecret,
};
