/**
 * Google sign-in configuration, set by the first user and stored with the client
 * secret encrypted in app_settings. Each API process keeps the decrypted copy in
 * memory only (never in Redis) and re-reads it after CONFIG_TTL_MS, so every
 * process follows a change without a restart.
 */

import { OAuth2Client } from 'google-auth-library';

import { loadGoogleAuthConfig } from '../models/user/user.admin.google.model.js';
import { logger } from './logger.js';

const CONFIG_TTL_MS = 15_000;

let cached = null;
let cachedAt = 0;
let inflight = null;
let generation = 0;
let oauthClient = null;
let oauthClientVersion = null;

async function refresh() {
  const startedAt = generation;
  let config = null;
  try {
    config = await loadGoogleAuthConfig();
  } catch (err) {
    // A secret that no longer decrypts turns sign-in off instead of failing every login page.
    logger.error({ err }, '[GoogleAuth] Saved Google sign-in settings could not be read');
  }
  // A read that began before an invalidation may predate the save, so don't cache it.
  if (startedAt === generation) {
    cached = config;
    cachedAt = Date.now();
  }
  return config;
}

/** The active Google client settings, or null when Google sign-in is off. */
async function getGoogleAuthConfig() {
  if (Date.now() - cachedAt < CONFIG_TTL_MS) return cached;
  // One DB read per expiry, however many requests arrive together.
  if (!inflight) {
    const pending = refresh().finally(() => {
      if (inflight === pending) inflight = null;
    });
    inflight = pending;
  }
  return inflight;
}

/** The OAuth client for a configuration, rebuilt only when the saved settings change. */
function oauthClientFor(config) {
  if (!oauthClient || oauthClientVersion !== config.version) {
    oauthClient = new OAuth2Client(config.clientId, config.clientSecret, config.redirectUri);
    oauthClientVersion = config.version;
  }
  return oauthClient;
}

/** Drop the cached copy so the next call reads the database (after a save in this process). */
function invalidateGoogleAuthConfig() {
  generation += 1;
  cachedAt = 0;
  inflight = null;
}

export { getGoogleAuthConfig, oauthClientFor, invalidateGoogleAuthConfig };
