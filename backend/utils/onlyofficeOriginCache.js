/**
 * In-memory cache for OnlyOffice origin (for CSP middleware)
 * TTL: 60 seconds to reduce DB/cache lookups on every request
 */
let onlyOfficeOriginCache = {
  origin: null,
  expiresAt: 0,
};
let refreshInProgress = false;
const ONLYOFFICE_ORIGIN_CACHE_TTL = 60 * 1000; // 60 seconds

/**
 * Refresh the cache in the background (async, non-blocking)
 */
async function refreshCache() {
  if (refreshInProgress) {
    return; // Already refreshing
  }

  refreshInProgress = true;
  const now = Date.now();

  try {
    const { getOnlyOfficeConfig } = require('../controllers/onlyoffice/onlyoffice.utils');
    const onlyOfficeConfig = await getOnlyOfficeConfig();

    if (onlyOfficeConfig.url) {
      try {
        const origin = new URL(onlyOfficeConfig.url).origin;
        // Update cache
        onlyOfficeOriginCache = {
          origin,
          expiresAt: now + ONLYOFFICE_ORIGIN_CACHE_TTL,
        };
      } catch {
        // Invalid URL, cache null
        onlyOfficeOriginCache = {
          origin: null,
          expiresAt: now + ONLYOFFICE_ORIGIN_CACHE_TTL,
        };
      }
    } else {
      // No URL configured, cache null
      onlyOfficeOriginCache = {
        origin: null,
        expiresAt: now + ONLYOFFICE_ORIGIN_CACHE_TTL,
      };
    }
  } catch (_err) {
    // On error, keep existing cache value (don't update)
    // This allows retry on next refresh cycle
  } finally {
    refreshInProgress = false;
  }
}

/**
 * Get OnlyOffice origin from cache (synchronous)
 * Returns cached value immediately, even if expired (stale-while-revalidate pattern)
 * Triggers background refresh if cache is expired
 * Never throws - always returns a value (null if error)
 */
function getCachedOnlyOfficeOrigin() {
  try {
    const now = Date.now();

    // If cache is expired, trigger background refresh (non-blocking)
    if (onlyOfficeOriginCache.expiresAt <= now && !refreshInProgress) {
      // Fire and forget - don't await
      // Wrap in try-catch in case refreshCache() throws synchronously (shouldn't happen, but defensive)
      try {
        refreshCache().catch(() => {
          // Ignore errors in background refresh
        });
      } catch {
        // Ignore any synchronous errors from refreshCache (shouldn't happen)
      }
    }

    // Return cached value immediately (even if expired - stale-while-revalidate)
    return onlyOfficeOriginCache.origin;
  } catch {
    // Defensive: if anything unexpected throws, return null
    // This ensures CSP middleware never crashes
    return null;
  }
}

/**
 * Invalidate OnlyOffice origin cache
 * Call this when OnlyOffice settings are updated
 * Also triggers immediate refresh
 * Never throws - all errors are caught internally
 */
function invalidateOnlyOfficeOriginCache() {
  try {
    onlyOfficeOriginCache = {
      origin: null,
      expiresAt: 0,
    };
    // Trigger immediate refresh in background
    // Wrap in try-catch in case refreshCache() throws synchronously (shouldn't happen, but defensive)
    try {
      refreshCache().catch(() => {
        // Ignore errors in background refresh
      });
    } catch {
      // Ignore any synchronous errors from refreshCache (shouldn't happen)
    }
  } catch {
    // Defensive: if anything unexpected throws, ignore it
    // This ensures admin controller never crashes
  }
}

module.exports = {
  getCachedOnlyOfficeOrigin,
  invalidateOnlyOfficeOriginCache,
};
