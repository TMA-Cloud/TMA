const pool = require('../../config/db');
const { logger } = require('../../config/logger');
const { deleteCache, cacheKeys, invalidateFileCache } = require('../../utils/cache');

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
    const { validateCustomDrivePath } = require('../../utils/customDriveValidation');
    const { UPLOAD_DIR } = require('../../config/paths');
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

    // Invalidate custom drive cache
    await deleteCache(cacheKeys.customDrive(userId));
    // Also invalidate file cache as custom drive changes affect file paths
    // This ensures /api/files?sortBy= cache is cleared immediately when switching to custom drive
    await invalidateFileCache(userId);

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
  getUserCustomDriveSettings,
  updateUserCustomDriveSettings,
  getUsersWithCustomDrive,
};
