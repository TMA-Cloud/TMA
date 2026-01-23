const { redisClient, isRedisConnected } = require('../config/redis');
const { logger } = require('../config/logger');
const crypto = require('crypto');

// Default TTL in seconds
const DEFAULT_TTL = 300; // 5 minutes

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
    await redisClient.setEx(key, ttl, serialized);
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
    const keys = [];
    let cursor = '0'; // Redis v5 requires cursor as string

    // Use SCAN instead of KEYS to avoid blocking Redis
    do {
      const result = await redisClient.scan(cursor, {
        MATCH: pattern,
        COUNT: 100, // Process in batches of 100
      });
      // Redis v5 returns cursor as string, '0' means done
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (cursor !== '0');

    if (keys.length === 0) {
      return 0;
    }

    // Delete keys in batches to avoid overwhelming Redis
    const batchSize = 100;
    let totalDeleted = 0;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const deleted = await redisClient.del(batch);
      totalDeleted += deleted;
    }

    return totalDeleted;
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
    `user:${userId}:*`,
    `storage:${userId}:*`,
    `search:${userId}:*`,
    `share:${userId}:*`,
    `custom_drive:${userId}:*`,
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

    // Also delete pattern-based keys (folder contents, file shared checks, etc.)
    totalDeleted += await deleteCachePattern(`share:token:${shareId}:*`);
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

  // Search cache keys (hashed to prevent cache key injection and ensure uniform key length)
  search: (userId, query, limit = 100) => {
    const normalizedQuery = query.toLowerCase().trim();
    // Hash the query to prevent cache key injection and ensure uniform key length
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

  // Custom drive cache keys
  customDrive: userId => `custom_drive:${userId}`,

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

  // App settings cache keys
  signupEnabled: () => `app:signup_enabled`,
  userCount: () => `app:user_count`,
  allUsers: () => `app:all_users`,
  onlyOfficeSettings: () => `app:onlyoffice_settings`,
  agentSettings: () => `app:agent_settings`,
  shareBaseUrlSettings: () => `app:share_base_url_settings`,

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

module.exports = {
  getCache,
  setCache,
  deleteCache,
  deleteCachePattern,
  invalidateEmailCache,
  invalidateUserCache,
  invalidateFileCache,
  invalidateSearchCache,
  invalidateShareCache,
  cacheKeys,
  DEFAULT_TTL,
};
