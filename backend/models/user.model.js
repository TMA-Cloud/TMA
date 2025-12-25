const pool = require('../config/db');
const { generateId } = require('../utils/id');
const { logger } = require('../config/logger');
const { getCache, setCache, deleteCache, cacheKeys, invalidateFileCache, DEFAULT_TTL } = require('../utils/cache');

async function createUser(email, password, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, password, name) VALUES($1,$2,$3,$4) RETURNING id, email, name',
    [id, email, password, name]
  );

  // Cache the new user (without password for security)
  const user = result.rows[0];
  await setCache(
    cacheKeys.userById(id),
    { id: user.id, email: user.email, name: user.name, token_version: 0 },
    DEFAULT_TTL * 2
  );
  // Note: We don't cache userByEmail on creation to avoid caching password
  // The password will be cached on first lookup if needed, but we should avoid that too

  // Invalidate user count cache
  await deleteCache(cacheKeys.userCount());
  await deleteCache(cacheKeys.allUsers());
  await deleteCache(cacheKeys.signupEnabled());

  return user;
}

async function getUserByEmail(email) {
  // SECURITY: Do NOT cache getUserByEmail because it's used for authentication
  // and contains password hashes. Password hashes should never be cached.
  // Always query from database to ensure we have the latest password hash
  // and to avoid storing sensitive data in Redis.
  const result = await pool.query('SELECT id, email, password, name FROM users WHERE email = $1', [email]);
  return result.rows[0];
}

async function getUserById(id) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userById(id);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT id, email, name, token_version FROM users WHERE id = $1', [id]);
  const user = result.rows[0];

  // Cache the result (longer TTL for user data)
  if (user) {
    await setCache(cacheKey, user, DEFAULT_TTL * 2); // 10 minutes TTL
  }

  return user;
}

/**
 * Get user's current token version for validation
 * @param {string} id - User ID
 * @returns {number|null} Token version or null if user not found
 */
async function getUserTokenVersion(id) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userTokenVersion(id);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT token_version FROM users WHERE id = $1', [id]);
  const tokenVersion = result.rows[0]?.token_version ?? null;

  // Cache the result (5 minutes TTL)
  if (tokenVersion !== null) {
    await setCache(cacheKey, tokenVersion, DEFAULT_TTL);
  }

  return tokenVersion;
}

/**
 * Invalidate all user sessions by incrementing token_version
 * @param {string} userId - User ID
 * @returns {number} New token version
 */
async function invalidateAllSessions(userId) {
  const result = await pool.query(
    `UPDATE users 
     SET token_version = token_version + 1, 
         last_token_invalidation = NOW() 
     WHERE id = $1 
     RETURNING token_version`,
    [userId]
  );
  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  // Invalidate user cache when token version changes
  await deleteCache(cacheKeys.userById(userId));
  await deleteCache(cacheKeys.userTokenVersion(userId));

  logger.info({ userId }, 'All user sessions invalidated');
  return result.rows[0].token_version;
}

async function getUserStorageUsage(userId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userStorage(userId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query(
    "SELECT COALESCE(SUM(size), 0) AS used FROM files WHERE user_id = $1 AND type = 'file' AND deleted_at IS NULL",
    [userId]
  );
  const usage = Number(res.rows[0].used) || 0;

  // Cache the result (shorter TTL as storage usage changes with file operations)
  await setCache(cacheKey, usage, 120); // 2 minutes TTL

  return usage;
}

async function getUserByGoogleId(googleId) {
  // Try to get from cache first
  const cacheKey = cacheKeys.userByGoogleId(googleId);
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const res = await pool.query('SELECT id, email, name, google_id FROM users WHERE google_id = $1', [googleId]);
  const user = res.rows[0];

  // Cache the result (10 minutes TTL)
  if (user) {
    await setCache(cacheKey, user, DEFAULT_TTL * 2);
  }

  return user;
}

async function createUserWithGoogle(googleId, email, name) {
  const id = generateId(16);
  const result = await pool.query(
    'INSERT INTO users(id, email, name, google_id) VALUES($1,$2,$3,$4) RETURNING id, email, name, google_id',
    [id, email, name, googleId]
  );

  // Cache the new user
  const user = result.rows[0];
  await setCache(
    cacheKeys.userById(id),
    { id: user.id, email: user.email, name: user.name, token_version: 0 },
    DEFAULT_TTL * 2
  );
  await setCache(
    cacheKeys.userByEmail(email),
    { id: user.id, email: user.email, name: user.name, google_id: user.google_id },
    DEFAULT_TTL * 2
  );
  await setCache(cacheKeys.userByGoogleId(googleId), user, DEFAULT_TTL * 2);

  // Invalidate user count cache
  await deleteCache(cacheKeys.userCount());
  await deleteCache(cacheKeys.allUsers());
  await deleteCache(cacheKeys.signupEnabled());

  return user;
}

async function updateGoogleId(userId, googleId) {
  // Get user email before updating for cache invalidation
  const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
  const email = userResult.rows[0]?.email;

  await pool.query('UPDATE users SET google_id = $1 WHERE id = $2', [googleId, userId]);

  // Invalidate user cache
  await deleteCache(cacheKeys.userById(userId));
  // Invalidate email cache if email exists
  if (email) {
    const { invalidateEmailCache } = require('../utils/cache');
    await invalidateEmailCache(email);
  }
}

async function isFirstUser(userId) {
  // Use stored first_user_id as source of truth (immutable, cannot be manipulated)
  const result = await pool.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);

  if (result.rows.length === 0 || !result.rows[0].first_user_id) {
    // If no first user is set, check if this is the first user by created_at
    // This handles the case where migration runs before first user is created
    const firstUserResult = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');
    if (firstUserResult.rows.length === 0) {
      return false; // No users exist
    }
    const isFirst = firstUserResult.rows[0].id === userId;

    // If this is the first user and not yet stored, store it (one-time operation)
    if (isFirst) {
      try {
        await pool.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
          userId,
          'app_settings',
        ]);
      } catch (err) {
        // Ignore if another request already set it (race condition handled)
        logger.warn('Could not set first_user_id (may already be set):', err.message);
      }
    }
    return isFirst;
  }

  // Compare with stored first_user_id (immutable source of truth)
  return result.rows[0].first_user_id === userId;
}

async function getSignupEnabled() {
  // Try to get from cache first
  const cacheKey = cacheKeys.signupEnabled();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT signup_enabled FROM app_settings WHERE id = $1', ['app_settings']);
  let signupEnabled;
  if (result.rows.length === 0) {
    // If settings don't exist, check if any users exist
    const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count, 10);
    // If no users exist, signup should be enabled
    signupEnabled = userCount === 0;
  } else {
    signupEnabled = result.rows[0].signup_enabled;
  }

  // Cache the result (5 minutes TTL - changes infrequently)
  await setCache(cacheKey, signupEnabled, DEFAULT_TTL);

  return signupEnabled;
}

async function getTotalUserCount() {
  // Try to get from cache first
  const cacheKey = cacheKeys.userCount();
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached;
  }

  // Cache miss - query database
  const result = await pool.query('SELECT COUNT(*) AS count FROM users');
  const count = Number(result.rows[0]?.count || 0);

  // Cache the result (5 minutes TTL)
  await setCache(cacheKey, count, DEFAULT_TTL);

  return count;
}

async function getAllUsersBasic() {
  // Try to get from cache first (without emails for security)
  const cacheKey = cacheKeys.allUsers();
  const cached = await getCache(cacheKey);

  if (cached !== null) {
    // Cache hit - fetch emails separately from database (emails not cached for security)
    // This gives us cache performance while protecting sensitive email data
    const emailResult = await pool.query('SELECT id, email FROM users ORDER BY created_at ASC');
    const emailMap = new Map(emailResult.rows.map(row => [row.id, row.email]));

    // Merge cached data with fresh emails
    return cached.map(user => ({
      ...user,
      email: emailMap.get(user.id) || null,
    }));
  }

  // Cache miss - query database
  const result = await pool.query('SELECT id, email, name, created_at FROM users ORDER BY created_at ASC');
  const users = result.rows;

  // Cache users WITHOUT emails for security (emails are sensitive PII)
  // If Redis is compromised, attackers won't get a clean email dump
  const usersWithoutEmails = users.map(user => ({
    id: user.id,
    name: user.name,
    created_at: user.created_at,
  }));
  await setCache(cacheKey, usersWithoutEmails, 120);

  // Return full data with emails (from database, not cache)
  return users;
}

async function setSignupEnabled(enabled, userId) {
  // Use transaction to ensure atomicity and verify user is first user
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Verify user is the first user using stored first_user_id
    const settingsResult = await client.query('SELECT first_user_id FROM app_settings WHERE id = $1', ['app_settings']);

    if (settingsResult.rows.length === 0) {
      throw new Error('App settings not found');
    }

    const storedFirstUserId = settingsResult.rows[0].first_user_id;

    // If first_user_id is not set yet, set it now (should only happen once)
    if (!storedFirstUserId) {
      // Get the actual first user
      const firstUserResult = await client.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1 FOR UPDATE');

      if (firstUserResult.rows.length === 0) {
        throw new Error('No users exist');
      }

      const actualFirstUserId = firstUserResult.rows[0].id;

      // Only allow if the requesting user is the actual first user
      if (actualFirstUserId !== userId) {
        await client.query('ROLLBACK');
        throw new Error('Only the first user can toggle signup');
      }

      // Set the first_user_id (immutable after this point)
      await client.query('UPDATE app_settings SET first_user_id = $1 WHERE id = $2 AND first_user_id IS NULL', [
        actualFirstUserId,
        'app_settings',
      ]);
    } else if (storedFirstUserId !== userId) {
      // Verify the requesting user matches the stored first user ID
      await client.query('ROLLBACK');
      throw new Error('Only the first user can toggle signup');
    }

    // Update signup enabled status
    await client.query('UPDATE app_settings SET signup_enabled = $1, updated_at = NOW() WHERE id = $2', [
      enabled,
      'app_settings',
    ]);

    await client.query('COMMIT');

    // Invalidate signup enabled cache
    await deleteCache(cacheKeys.signupEnabled());

    // Log security event
    logger.info(`[SECURITY] Signup ${enabled ? 'enabled' : 'disabled'} by first user (ID: ${userId})`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Get user's custom drive settings
 * @param {string} userId - User ID
 * @returns {Promise<{enabled: boolean, path: string|null}>}
 */
async function getUserCustomDriveSettings(userId) {
  const result = await pool.query('SELECT custom_drive_enabled, custom_drive_path FROM users WHERE id = $1', [userId]);

  if (result.rows.length === 0) {
    throw new Error('User not found');
  }

  return {
    enabled: result.rows[0].custom_drive_enabled || false,
    path: result.rows[0].custom_drive_path || null,
  };
}

/**
 * Update user's custom drive settings
 * @param {string} userId - User ID
 * @param {boolean} enabled - Whether custom drive is enabled
 * @param {string|null} path - Custom drive path (must be absolute)
 * @returns {Promise<{enabled: boolean, path: string|null}>}
 */
async function updateUserCustomDriveSettings(userId, enabled, path) {
  // Get current settings to check if path is already set
  const currentSettings = await getUserCustomDriveSettings(userId);

  // If user already has a path set and is trying to change it, reject
  if (currentSettings.enabled && currentSettings.path && enabled && path) {
    const pathModule = require('path');
    const currentPathNormalized = pathModule.resolve(currentSettings.path).toLowerCase();
    const newPathNormalized = pathModule.resolve(path).toLowerCase();

    // Only allow if paths are the same (user keeping same path)
    if (currentPathNormalized !== newPathNormalized) {
      throw new Error('Cannot change custom drive path. Please disable custom drive first, then set a new path.');
    }
  }

  // Validate path if enabling
  if (enabled && path) {
    const pathModule = require('path');
    const { validateCustomDrivePath } = require('../utils/customDriveValidation');
    const { UPLOAD_DIR } = require('../config/paths');
    const fs = require('fs').promises;

    // Comprehensive security validation
    const validation = await validateCustomDrivePath(path, userId, pool);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const resolvedPath = pathModule.resolve(path);

    // Cleanup: Delete all files and folders from upload_dir for this user when enabling custom drive
    // This ensures users don't have files in both locations
    try {
      // Get all files and folders for this user that are in the upload_dir (relative paths)
      const uploadFiles = await pool.query('SELECT id, path, type FROM files WHERE user_id = $1 AND path IS NOT NULL', [
        userId,
      ]);

      const uploadDirFiles = [];
      const foldersToDelete = [];

      for (const file of uploadFiles.rows) {
        // Files in upload_dir have relative paths (not absolute)
        if (!pathModule.isAbsolute(file.path)) {
          uploadDirFiles.push(file);
          if (file.type === 'folder') {
            foldersToDelete.push(file.path);
          }
        }
      }

      // Delete physical files and folders from disk first, then delete from database
      // This prevents orphaned files if database deletion succeeds but physical deletion fails
      const successfullyDeletedFileIds = [];
      const failedDeletions = [];

      if (uploadDirFiles.length > 0) {
        // Delete physical files first
        for (const file of uploadDirFiles) {
          if (file.type === 'file') {
            const filePath = pathModule.join(UPLOAD_DIR, file.path);
            try {
              await fs.unlink(filePath);
              successfullyDeletedFileIds.push(file.id);
            } catch (error) {
              // File might not exist, be locked, or have permission issues
              logger.warn(
                { filePath, fileId: file.id, error: error.message },
                'Could not delete upload file from disk'
              );
              failedDeletions.push({ id: file.id, path: file.path, error: error.message });
            }
          }
        }

        // Delete folders (in reverse order to handle nested folders)
        // Only delete folders if all their files were successfully deleted
        foldersToDelete.sort((a, b) => b.length - a.length);
        for (const folderPath of foldersToDelete) {
          const folderFile = uploadDirFiles.find(f => f.path === folderPath && f.type === 'folder');
          if (!folderFile) continue;

          const fullFolderPath = pathModule.join(UPLOAD_DIR, folderPath);
          try {
            const contents = await fs.readdir(fullFolderPath);
            if (contents.length === 0) {
              await fs.rmdir(fullFolderPath);
              successfullyDeletedFileIds.push(folderFile.id);
            } else {
              // Folder not empty - don't delete from database yet
              logger.warn({ folderPath: fullFolderPath }, 'Folder not empty, skipping deletion');
              failedDeletions.push({ id: folderFile.id, path: folderPath, error: 'Folder not empty' });
            }
          } catch (error) {
            // Folder might not exist, have permission issues, or be locked
            logger.warn(
              { folderPath: fullFolderPath, error: error.message },
              'Could not delete upload folder from disk'
            );
            failedDeletions.push({ id: folderFile.id, path: folderPath, error: error.message });
          }
        }

        // Only delete from database for files/folders that were successfully deleted from disk
        let deletedCount = 0;
        if (successfullyDeletedFileIds.length > 0) {
          const deleteResult = await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
            successfullyDeletedFileIds,
            userId,
          ]);
          deletedCount = deleteResult.rowCount;
        }

        // Log warnings for files that couldn't be deleted from disk
        if (failedDeletions.length > 0) {
          logger.warn(
            { userId, failedCount: failedDeletions.length, failedDeletions },
            'Some files could not be deleted from disk when enabling custom drive - database records preserved'
          );
        }

        if (deletedCount > 0) {
          logger.info({ userId, deletedCount }, 'Cleaned up upload_dir files and folders when enabling custom drive');
        }
      }
    } catch (error) {
      logger.error({ userId, error: error.message }, 'Error cleaning up upload_dir files when enabling custom drive');
      // Continue anyway - don't fail the enable operation
    }

    // Update with resolved path
    const result = await pool.query(
      'UPDATE users SET custom_drive_enabled = $1, custom_drive_path = $2 WHERE id = $3 RETURNING custom_drive_enabled, custom_drive_path',
      [enabled, resolvedPath, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    logger.info({ userId, enabled, path: resolvedPath }, 'User custom drive settings updated');

    return {
      enabled: result.rows[0].custom_drive_enabled,
      path: result.rows[0].custom_drive_path,
    };
  } else {
    // Disable custom drive - cleanup database entries
    const pathModule = require('path');

    // Get all files for this user to check which ones are absolute paths (custom drive files)
    const allFiles = await pool.query('SELECT id, path FROM files WHERE user_id = $1 AND path IS NOT NULL', [userId]);

    // Filter files with absolute paths (custom drive files)
    const customDriveFileIds = [];
    for (const file of allFiles.rows) {
      if (pathModule.isAbsolute(file.path)) {
        customDriveFileIds.push(file.id);
      }
    }

    // Delete all custom drive files/folders from database
    let deletedCount = 0;
    if (customDriveFileIds.length > 0) {
      const deleteResult = await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [
        customDriveFileIds,
        userId,
      ]);
      deletedCount = deleteResult.rowCount;
    }

    logger.info({ userId, deletedCount }, 'Cleaned up custom drive files from database');

    // Update user settings
    const result = await pool.query(
      'UPDATE users SET custom_drive_enabled = $1, custom_drive_path = NULL WHERE id = $2 RETURNING custom_drive_enabled, custom_drive_path',
      [false, userId]
    );

    if (result.rows.length === 0) {
      throw new Error('User not found');
    }

    logger.info({ userId }, 'User custom drive disabled');

    // Invalidate custom drive cache
    await deleteCache(cacheKeys.customDrive(userId));
    // Also invalidate file cache as custom drive changes affect file paths
    await invalidateFileCache(userId);

    return {
      enabled: false,
      path: null,
    };
  }
}

/**
 * Get all users with custom drive enabled
 * @returns {Promise<Array<{id: string, custom_drive_path: string}>>}
 */
async function getUsersWithCustomDrive() {
  const result = await pool.query(
    'SELECT id, custom_drive_path FROM users WHERE custom_drive_enabled = TRUE AND custom_drive_path IS NOT NULL',
    []
  );

  return result.rows.map(row => ({
    id: row.id,
    custom_drive_path: row.custom_drive_path,
  }));
}

module.exports = {
  createUser,
  getUserByEmail,
  getUserById,
  getUserStorageUsage,
  getUserByGoogleId,
  createUserWithGoogle,
  updateGoogleId,
  isFirstUser,
  getSignupEnabled,
  setSignupEnabled,
  getTotalUserCount,
  getAllUsersBasic,
  getUserTokenVersion,
  invalidateAllSessions,
  getUserCustomDriveSettings,
  updateUserCustomDriveSettings,
  getUsersWithCustomDrive,
};
