/**
 * Object storage configuration, set by the first user and stored encrypted in
 * app_settings. Each process keeps the decrypted copy in memory only (never in
 * Redis) and re-reads it after a short TTL, so the API and worker converge on a
 * change within CONFIG_TTL_MS without a restart.
 */

import { loadStorageConfig } from '../models/user/user.admin.storage.model.js';

const CONFIG_TTL_MS = 15_000;

class StorageNotConfiguredError extends Error {
  constructor() {
    super('Storage is not configured. The administrator must connect a storage bucket in Settings.');
    this.name = 'StorageNotConfiguredError';
    this.code = 'STORAGE_NOT_CONFIGURED';
    this.status = 503;
  }
}

let cached = null;
let cachedAt = 0;
let inflight = null;
let generation = 0;

async function refresh() {
  const startedAt = generation;
  const config = await loadStorageConfig();
  // A read that began before an invalidation may predate the save, so don't cache it.
  if (startedAt === generation) {
    cached = config;
    cachedAt = Date.now();
  }
  return config;
}

/** The active configuration, or null when storage has not been set up. */
async function getS3ConfigOrNull() {
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

/** The active configuration; throws StorageNotConfiguredError when there is none. */
async function getS3Config() {
  const config = await getS3ConfigOrNull();
  if (!config) throw new StorageNotConfiguredError();
  return config;
}

/** Drop the cached copy so the next call reads the database (after a save in this process). */
function invalidateS3Config() {
  generation += 1;
  cachedAt = 0;
  inflight = null;
}

export { StorageNotConfiguredError, getS3Config, getS3ConfigOrNull, invalidateS3Config };
