import crypto from 'crypto';

import { logger } from '../config/logger.js';
import { redisClient, isRedisConnected } from '../config/redis.js';

// Default TTL in seconds
const DEFAULT_TTL = 300; // 5 minutes
// A sorted-set registry records each cache key's own expiry. Unlike the old
// Set registry, dead members can be pruned even when an active user keeps the
// registry itself alive indefinitely.
const CACHE_INDEX_PREFIX = '__cache_index_v2__:';

function registryPrefixes(key) {
  const parts = String(key).split(':');
  switch (parts[0]) {
    case 'files':
    case 'file':
    case 'search':
    case 'session':
    case 'user':
    case 'storage':
      return parts[1] ? [`${parts[0]}:${parts[1]}`] : [];
    case 'share':
      if (parts[1] === 'folder' || parts[1] === 'check') {
        return parts[2] ? [`share:${parts[1]}:${parts[2]}`] : [];
      }
      if (parts[1] === 'token') {
        return parts[2] ? [`share:token:${parts[2]}`] : [];
      }
      return parts[1] && parts[1] !== 'token' ? [`share:${parts[1]}`] : [];
    case 'folder':
      return parts[1] ? [`folder:${parts[1]}`] : [];
    default:
      return [];
  }
}

/**
 * Get value from cache
 * @param {string} key - Cache key
 * @returns {Promise<any|null>} Cached value or null if not found
 */
async function getCache(key) {
  if (!isRedisConnected()) {
    return null;
  }

  try {
    const value = await redisClient.get(key);
    if (value === null) {
      return null;
    }
    return JSON.parse(value);
  } catch (err) {
    logger.warn({ err, key }, 'Error getting from cache');
    return null;
  }
}

async function getCaches(keys) {
  if (!isRedisConnected() || !Array.isArray(keys) || keys.length === 0) return keys?.map(() => null) || [];
  try {
    const values =
      typeof redisClient.mGet === 'function'
        ? await redisClient.mGet(keys)
        : await Promise.all(keys.map(key => redisClient.get(key)));
    return values.map(value => {
      if (value === null) return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    });
  } catch (err) {
    logger.warn({ err, count: keys.length }, 'Error getting cache keys');
    return keys.map(() => null);
  }
}

async function setCaches(entries, ttl = DEFAULT_TTL) {
  if (!isRedisConnected() || !Array.isArray(entries) || entries.length === 0) return false;
  try {
    if (typeof redisClient.multi !== 'function') {
      await Promise.all(entries.map(([key, value]) => setCache(key, value, ttl)));
      return true;
    }
    const batch = redisClient.multi();
    const registries = new Set();
    const expiresAt = Date.now() + ttl * 1000;
    for (const [key, value] of entries) {
      batch.setEx(key, ttl, JSON.stringify(value));
      for (const prefix of registryPrefixes(key)) {
        const registry = `${CACHE_INDEX_PREFIX}${prefix}`;
        batch.zAdd(registry, { score: expiresAt, value: key });
        registries.add(registry);
      }
    }
    for (const registry of registries) {
      batch.zRemRangeByScore(registry, 0, Date.now());
      batch.expire(registry, ttl + 60);
    }
    await batch.exec();
    return true;
  } catch (err) {
    logger.warn({ err, count: entries.length }, 'Error setting cache keys');
    return false;
  }
}

/**
 * Set value in cache
 * @param {string} key - Cache key
 * @param {any} value - Value to cache
 * @param {number} ttl - Time to live in seconds (default: 5 minutes)
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function setCache(key, value, ttl = DEFAULT_TTL) {
  if (!isRedisConnected()) {
    return false;
  }

  try {
    const serialized = JSON.stringify(value);
    const prefixes = registryPrefixes(key);
    // Use one Redis round trip and only index prefixes that are actually
    // invalidated by the application.
    if (prefixes.length > 0 && typeof redisClient.multi === 'function') {
      const batch = redisClient.multi().setEx(key, ttl, serialized);
      for (const prefix of prefixes) {
        const registry = `${CACHE_INDEX_PREFIX}${prefix}`;
        batch
          .zAdd(registry, { score: Date.now() + ttl * 1000, value: key })
          .zRemRangeByScore(registry, 0, Date.now())
          .expire(registry, ttl + 60);
      }
      await batch.exec();
    } else {
      await redisClient.setEx(key, ttl, serialized);
      if (typeof redisClient.sAdd === 'function') {
        await Promise.all(
          prefixes.map(async prefix => {
            const registry = `${CACHE_INDEX_PREFIX}${prefix}`;
            await redisClient.sAdd(registry, key);
            await redisClient.expire(registry, ttl + 60);
          })
        );
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err, key }, 'Error setting cache');
    return false;
  }
}

/**
 * Delete a single key from cache
 * @param {string} key - Cache key to delete
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function deleteCache(key) {
  if (!isRedisConnected()) {
    return false;
  }

  try {
    await redisClient.del(key);
    return true;
  } catch (err) {
    logger.warn({ err, key }, 'Error deleting from cache');
    return false;
  }
}

async function deleteCaches(keys) {
  if (!isRedisConnected()) return 0;
  const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
  if (uniqueKeys.length === 0) return 0;
  try {
    return typeof redisClient.unlink === 'function'
      ? await redisClient.unlink(uniqueKeys)
      : await redisClient.del(uniqueKeys);
  } catch (err) {
    logger.warn({ err, count: uniqueKeys.length }, 'Error deleting cache keys');
    return 0;
  }
}

/**
 * Delete multiple keys matching a pattern using SCAN (non-blocking)
 * @param {string} pattern - Pattern to match (e.g., 'user:*')
 * @returns {Promise<number>} Number of keys deleted
 */
async function deleteCachePattern(pattern) {
  if (!isRedisConnected()) {
    return 0;
  }

  try {
    const wildcardIndex = pattern.indexOf('*');
    const keyPrefix = wildcardIndex >= 0 ? pattern.slice(0, wildcardIndex) : pattern;
    const indexedPrefix = registryPrefixes(keyPrefix)[0];
    if (indexedPrefix && typeof redisClient.zRangeByScore === 'function') {
      const registry = `${CACHE_INDEX_PREFIX}${indexedPrefix}`;
      await redisClient.zRemRangeByScore(registry, 0, Date.now());
      const indexedKeys = await redisClient.zRangeByScore(registry, Date.now(), '+inf');
      const matchingKeys = indexedKeys.filter(key => key.startsWith(keyPrefix));
      if (matchingKeys.length === 0) return 0;
      const deleted = await deleteCaches(matchingKeys);
      if (matchingKeys.length === indexedKeys.length) await redisClient.del(registry);
      else if (typeof redisClient.zRem === 'function') await redisClient.zRem(registry, matchingKeys);
      return deleted;
    }

    // All pattern-invalidated application caches have a short-lived prefix
    // registry. Entries from releases predating the registry expire naturally;
    // never traverse the entire Redis keyspace from a request path.
    return 0;
  } catch (err) {
    logger.warn({ err, pattern }, 'Error deleting cache pattern');
    return 0;
  }
}

/**
 * Invalidate email-based cache for a specific email
 * @param {string} email - Email address to invalidate
 * @returns {Promise<boolean>} True if successful
 */
async function invalidateEmailCache(email) {
  const cacheKey = cacheKeys.userByEmail(email);
  return deleteCache(cacheKey);
}

/**
 * Invalidate all cache entries for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} Number of keys deleted
 */
async function invalidateUserCache(userId) {
  const patterns = [
    `files:${userId}:*`,
    `file:${userId}:*`,
    `user:${userId}:*`,
    `storage:${userId}:*`,
    `search:${userId}:*`,
    `share:${userId}:*`,
  ];

  let totalDeleted = 0;
  for (const pattern of patterns) {
    const deleted = await deleteCachePattern(pattern);
    totalDeleted += deleted;
  }

  return totalDeleted;
}

/**
 * Invalidate file-related cache for a user
 * @param {string} userId - User ID
 * @param {string|null} parentId - Optional parent ID to invalidate specific folder
 * @returns {Promise<number>} Number of keys deleted
 */
async function invalidateFileCache(userId, parentId = null) {
  if (parentId) {
    // Invalidate specific folder and all parent folders
    const patterns = [
      `files:${userId}:${parentId}:*`,
      `files:${userId}:*`, // Also invalidate root to be safe
    ];
    let totalDeleted = 0;
    for (const pattern of patterns) {
      const deleted = await deleteCachePattern(pattern);
      totalDeleted += deleted;
    }
    return totalDeleted;
  } else {
    // Invalidate all file caches for user
    return deleteCachePattern(`files:${userId}:*`);
  }
}

/**
 * Invalidate search cache for a user
 * @param {string} userId - User ID
 * @returns {Promise<number>} Number of keys deleted
 */
async function invalidateSearchCache(userId) {
  return deleteCachePattern(`search:${userId}:*`);
}

/**
 * Invalidate the full bundle of caches affected by a file mutation (file cache,
 * search, and optionally fileStats + userStorage).
 * @param {string} userId - User ID
 * @param {string|null} [parentId] - Parent folder ID (optional)
 * @param {Object} [options] - oldParentId (e.g. move source), includeStats, includeStorage
 */
async function invalidateAllFileCaches(userId, parentId = null, options = {}) {
  const { oldParentId = null, includeStats = true, includeStorage = true } = options;

  await invalidateFileCache(userId, parentId);
  if (oldParentId && oldParentId !== parentId) {
    await invalidateFileCache(userId, oldParentId);
  }
  await invalidateSearchCache(userId);
  // Folder totals can change for any ancestor; one per-user registry avoids a
  // recursive invalidation query on every mutation.
  await deleteCachePattern(`folder:${userId}:*`);
  if (includeStats) {
    await deleteCache(cacheKeys.fileStats(userId));
  }
  if (includeStorage) {
    await deleteCache(cacheKeys.userStorage(userId));
  }
}

/**
 * Invalidate share link cache
 * @param {string} shareId - Share link ID
 * @param {string|null} userId - Optional user ID to invalidate user's share caches
 * @returns {Promise<number>} Number of keys deleted
 */
async function invalidateShareCache(shareId, userId = null) {
  let totalDeleted = 0;

  if (shareId) {
    // Delete exact shareByToken key first
    const exactKey = cacheKeys.shareByToken(shareId);
    const deletedExact = await deleteCache(exactKey);
    totalDeleted += deletedExact ? 1 : 0;

    // Also delete pattern-based keys (file shared checks, etc.)
    totalDeleted += await deleteCachePattern(`share:check:${shareId}:*`);
    // Compatibility with cache keys created by older releases.
    totalDeleted += await deleteCachePattern(`share:token:${shareId}:*`);
    // Public folder listings are keyed share:folder:{token}:{folderId}; the
    // token is the share id, so drop every listing cached under this share.
    totalDeleted += await deleteCachePattern(`share:folder:${shareId}:*`);
  }

  if (userId) {
    totalDeleted += await deleteCachePattern(`share:${userId}:*`);
  }

  return totalDeleted;
}

/**
 * Cache key generators
 */
const cacheKeys = {
  // File cache keys
  files: (userId, parentId = null, sortBy = 'modified', order = 'DESC') => {
    const parent = parentId || 'root';
    return `files:${userId}:${parent}:${sortBy}:${order}`;
  },

  // Search keys hash the query (prevents key injection, uniform length).
  search: (userId, query, limit = 100) => {
    const normalizedQuery = query.toLowerCase().trim();
    const queryHash = crypto.createHash('sha256').update(normalizedQuery).digest('hex').slice(0, 16);
    return `search:${userId}:${queryHash}:${limit}`;
  },

  // User cache keys
  userById: userId => `user:${userId}:id`,
  userByEmail: email => {
    // Hash email for privacy/compliance (GDPR, etc.)
    const normalizedEmail = email.toLowerCase().trim();
    const emailHash = crypto.createHash('sha256').update(normalizedEmail).digest('hex').slice(0, 16);
    return `user:email:${emailHash}`;
  },
  userStorage: userId => `storage:${userId}:usage`,

  // Share cache keys
  shareLink: (fileId, userId) => `share:${userId}:${fileId}`,
  shareByToken: token => `share:token:${token}`,

  // File stats cache keys
  fileStats: userId => `files:${userId}:stats`,

  // Recently opened files
  recentFiles: userId => `files:${userId}:recent`,

  // Starred files cache keys
  starredFiles: (userId, sortBy = 'modified', order = 'DESC') => {
    return `files:${userId}:starred:${sortBy}:${order}`;
  },

  // Shared files cache keys
  sharedFiles: (userId, sortBy = 'modified', order = 'DESC') => {
    return `files:${userId}:shared:${sortBy}:${order}`;
  },

  // Trash files cache keys
  trashFiles: (userId, sortBy = 'deletedAt', order = 'DESC') => {
    return `files:${userId}:trash:${sortBy}:${order}`;
  },

  // Single file cache keys
  file: (fileId, userId) => `file:${userId}:${fileId}`,

  // Folder size cache keys
  folderSize: (folderId, userId) => `folder:${userId}:${folderId}:size`,

  // Session cache keys
  session: (sessionId, userId, tokenVersion) => `session:${userId}:${sessionId}:${tokenVersion}`,
  activeSessions: (userId, tokenVersion) => `sessions:${userId}:${tokenVersion}`,

  // User token version cache keys
  userTokenVersion: userId => `user:${userId}:token_version`,

  // Account resolution cache keys (owner id + role for a login identity)
  userAccount: userId => `user:${userId}:account`,
  subUsers: ownerId => `user:${ownerId}:sub_users`,

  // App settings cache keys
  signupEnabled: () => `app:signup_enabled`,
  userCount: () => `app:user_count`,
  allUsers: () => `app:all_users`,
  onlyOfficeSettings: () => `app:onlyoffice_settings`,
  shareBaseUrlSettings: () => `app:share_base_url_settings`,
  maxUploadSizeSettings: () => `app:max_upload_size_settings`,
  hideFileExtensionsSettings: () => `app:hide_file_extensions`,
  electronOnlyAccessSettings: () => `app:electron_only_access`,
  passwordChangeSettings: () => `app:password_change`,

  // Google OAuth cache keys
  userByGoogleId: googleId => `user:google:${googleId}`,

  // Share folder contents cache keys (for share links)
  shareFolderContentsByToken: (token, folderId = null) => {
    const folder = folderId || 'root';
    return `share:folder:${token}:${folder}`;
  },

  // Share folder contents cache keys (for user's own folders)
  shareFolderContents: (folderId, userId) => `share:folder:${folderId}:${userId}`,

  // File shared check cache keys
  fileShared: (token, fileId) => `share:check:${token}:${fileId}`,
};

export {
  getCache,
  getCaches,
  setCache,
  setCaches,
  deleteCache,
  deleteCaches,
  deleteCachePattern,
  invalidateEmailCache,
  invalidateUserCache,
  invalidateFileCache,
  invalidateSearchCache,
  invalidateAllFileCaches,
  invalidateShareCache,
  cacheKeys,
  DEFAULT_TTL,
};
