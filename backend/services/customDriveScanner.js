const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const pool = require('../config/db');
const { generateId } = require('../utils/id');

/**
 * Scans the custom drive directory and inserts all files and folders into the database
 * Maintains the exact folder structure as it exists on disk
 * @param {string} customDrivePath - The absolute path to the custom drive directory
 */
async function scanCustomDrive(customDrivePath) {
  const normalizedPath = path.resolve(customDrivePath);
  
  // Validate that the path exists
  try {
    const stat = await fs.stat(normalizedPath);
    if (!stat.isDirectory()) {
      logger.error(`[Custom Drive] Path is not a directory: ${normalizedPath}`);
      return;
    }
  } catch (error) {
    logger.error(`[Custom Drive] Cannot access directory: ${normalizedPath}`, error.message);
    return;
  }

  try {
    const usersResult = await pool.query('SELECT id FROM users');
    const userIds = usersResult.rows.map(row => row.id);

    if (userIds.length === 0) {
      logger.info('[Custom Drive] No users found, skipping scan');
      return;
    }

    logger.info(`[Custom Drive] Starting scan for ${userIds.length} user(s)`);
    const folderMap = new Map();
    await scanDirectory(normalizedPath, null, userIds, folderMap);
    logger.info('[Custom Drive] Scan completed successfully');
  } catch (error) {
    logger.error('[Custom Drive] Error during scan:', error);
    throw error;
  }
}

/**
 * Recursively scans a directory and inserts files/folders into the database
 * @param {string} dirPath - Absolute path of the directory to scan
 * @param {Object<string, string>|null} parentFolderIds - Map of userId -> parent folder ID (null for root)
 * @param {string[]} userIds - Array of user IDs to insert files for
 * @param {Map<string, Object<string, string>>} folderMap - Map of absolute paths to folder IDs per user
 */
async function scanDirectory(dirPath, parentFolderIds, userIds, folderMap) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      try {
        if (entry.isDirectory()) {
          // Batch create folders for all users
          const parentIdMap = parentFolderIds || {};
          const folderIdsMap = await batchCreateOrUpdateFolders(entry.name, parentIdMap, userIds, entryPath);

          // Convert Map to object
          const folderIds = {};
          for (const userId of userIds) {
            folderIds[userId] = folderIdsMap.get(userId);
          }

          // Store the folder mapping
          folderMap.set(entryPath, folderIds);

          // Recursively scan subdirectories with the new folder IDs as parent
          await scanDirectory(entryPath, folderIds, userIds, folderMap);
        } else if (entry.isFile()) {
          const stats = await fs.stat(entryPath);
          const mimeType = getMimeType(entry.name);
          const parentIdMap = parentFolderIds || {};

          await batchCreateOrUpdateFiles(
            entry.name,
            stats.size,
            mimeType,
            entryPath,
            parentIdMap,
            userIds
          );
        }
      } catch (error) {
        logger.error(`[Custom Drive] Error processing ${entryPath}:`, error.message);
        // Continue with other entries on error
      }
    }
  } catch (error) {
    logger.error(`[Custom Drive] Cannot read directory ${dirPath}:`, error.message);
    // Skip directories we can't read (permissions, etc.)
  }
}

/**
 * Batch creates or updates folder entries for multiple users
 * @param {string} name - Folder name
 * @param {Object<string, string|null>} parentIds - Map of userId -> parentId
 * @param {string[]} userIds - Array of user IDs
 * @param {string} absolutePath - Absolute path of the folder
 * @returns {Promise<Map<string, string>>} Map of userId -> folderId
 */
async function batchCreateOrUpdateFolders(name, parentIds, userIds, absolutePath) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const folderIdsMap = new Map();

    for (const userId of userIds) {
      const parentId = parentIds[userId] || null;

      // Normalize path to ensure consistency (lowercase for Windows case-insensitivity)
      const normalizedPath = path.resolve(absolutePath).toLowerCase();

      // Check if folder already exists for this user and path (case-insensitive)
      const existing = await client.query(
        'SELECT id, path FROM files WHERE LOWER(path) = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
        [normalizedPath, userId, 'folder']
      );

      if (existing.rows.length > 0) {
        // Update existing folder (keep same ID)
        await client.query(
          'UPDATE files SET name = $1, parent_id = $2, modified = NOW() WHERE id = $3',
          [name, parentId, existing.rows[0].id]
        );
        folderIdsMap.set(userId, existing.rows[0].id);
      } else {
        // Insert new folder (store original case path)
        const id = generateId(16);
        const originalCasePath = path.resolve(absolutePath);
        await client.query(
          'INSERT INTO files(id, name, type, parent_id, user_id, path) VALUES($1, $2, $3, $4, $5, $6)',
          [id, name, 'folder', parentId, userId, originalCasePath]
        );
        folderIdsMap.set(userId, id);
      }
    }

    await client.query('COMMIT');
    return folderIdsMap;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[Custom Drive] Error in batchCreateOrUpdateFolders:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Creates a folder entry in the database (single user - for backward compatibility)
 */
async function createFolderEntry(name, parentId, userId, absolutePath) {
  const result = await batchCreateOrUpdateFolders(name, { [userId]: parentId }, [userId], absolutePath);
  return result.get(userId);
}

/**
 * Batch creates or updates file entries for multiple users
 * @param {string} name - File name
 * @param {number} size - File size in bytes
 * @param {string} mimeType - MIME type
 * @param {string} absolutePath - Absolute path of the file
 * @param {Object<string, string|null>} parentIds - Map of userId -> parentId
 * @param {string[]} userIds - Array of user IDs
 * @returns {Promise<Map<string, Object>>} Map of userId -> {id}
 */
async function batchCreateOrUpdateFiles(name, size, mimeType, absolutePath, parentIds, userIds) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileIdsMap = new Map();

    for (const userId of userIds) {
      const parentId = parentIds[userId] || null;

      // Normalize path to ensure consistency (lowercase for Windows case-insensitivity)
      const normalizedPath = path.resolve(absolutePath).toLowerCase();

      // Check if file already exists for this user and path (case-insensitive)
      const existing = await client.query(
        'SELECT id, path FROM files WHERE LOWER(path) = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
        [normalizedPath, userId, 'file']
      );

      if (existing.rows.length > 0) {
        // Update existing file (keep same ID)
        await client.query(
          'UPDATE files SET name = $1, size = $2, mime_type = $3, parent_id = $4, modified = NOW() WHERE id = $5',
          [name, size, mimeType, parentId, existing.rows[0].id]
        );
        fileIdsMap.set(userId, { id: existing.rows[0].id });
      } else {
        // Insert new file (store original case path)
        const id = generateId(16);
        const originalCasePath = path.resolve(absolutePath);
        await client.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
          [id, name, 'file', size, mimeType, originalCasePath, parentId, userId]
        );
        fileIdsMap.set(userId, { id });
      }
    }

    await client.query('COMMIT');
    return fileIdsMap;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[Custom Drive] Error in batchCreateOrUpdateFiles:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Creates a file entry in the database (single user - for backward compatibility)
 */
async function createFileEntry(name, size, mimeType, absolutePath, parentId, userId) {
  const result = await batchCreateOrUpdateFiles(name, size, mimeType, absolutePath, { [userId]: parentId }, [userId]);
  const entry = result.get(userId);
  return entry?.id || null;
}

/**
 * Gets MIME type from file extension
 * @param {string} filename - File name
 * @returns {string} MIME type
 */
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeTypes = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
    '.mp4': 'video/mp4',
    '.mp3': 'audio/mpeg',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

/**
 * Incrementally syncs the custom drive - detects changes and updates database
 * This is more efficient than a full scan as it only processes changes
 * @param {string} customDrivePath - The absolute path to the custom drive directory
 */
async function syncCustomDrive(customDrivePath) {
  const normalizedPath = path.resolve(customDrivePath);
  
  // Validate that the path exists
  try {
    const stat = await fs.stat(normalizedPath);
    if (!stat.isDirectory()) {
      logger.error(`[Custom Drive] Path is not a directory: ${normalizedPath}`);
      return;
    }
  } catch (error) {
    logger.error(`[Custom Drive] Cannot access directory: ${normalizedPath}`, error.message);
    return;
  }

  try {
    // Get all users
    const usersResult = await pool.query('SELECT id FROM users');
    const userIds = usersResult.rows.map(row => row.id);

    if (userIds.length === 0) {
      return;
    }

    const dbEntries = new Map();
    const normalizedPathLower = normalizedPath.toLowerCase();
    const dbResult = await pool.query(
      "SELECT id, name, type, size, modified, path FROM files WHERE path IS NOT NULL AND LOWER(path) LIKE $1 || '%' ESCAPE ''",
      [normalizedPathLower]
    );

    for (const row of dbResult.rows) {
      if (row.path && path.isAbsolute(row.path)) {
        // Store with lowercase key for case-insensitive lookup
        dbEntries.set(row.path.toLowerCase(), row);
      }
    }

    // Recursively scan and sync
    await syncDirectory(normalizedPath, null, userIds, dbEntries);

  } catch (error) {
    logger.error('[Custom Drive] Error during sync:', error);
    throw error;
  }
}

/**
 * Recursively syncs a directory
 * @param {string} dirPath - Directory path to sync
 * @param {Object<string, string>|null} parentFolderIds - Map of userId -> parent folder ID
 * @param {string[]} userIds - Array of user IDs
 * @param {Map<string, Object>} dbEntries - Map of existing database entries
 */
async function syncDirectory(dirPath, parentFolderIds, userIds, dbEntries) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);

      try {
        if (entry.isDirectory()) {
          const parentIdMap = parentFolderIds || {};
          const folderIdsMap = await batchCreateOrUpdateFolders(entry.name, parentIdMap, userIds, entryPath);
          
          const folderIds = {};
          for (const userId of userIds) {
            folderIds[userId] = folderIdsMap.get(userId);
          }
          
          await syncDirectory(entryPath, folderIds, userIds, dbEntries);
        } else if (entry.isFile()) {
          const stats = await fs.stat(entryPath);
          const mimeType = getMimeType(entry.name);
          const parentIdMap = parentFolderIds || {};
          
          await batchCreateOrUpdateFiles(
            entry.name,
            stats.size,
            mimeType,
            entryPath,
            parentIdMap,
            userIds
          );
        }
      } catch (error) {
        // Continue with other entries on error
      }
    }
  } catch (error) {
    // Skip directories we can't read (permissions, etc.)
  }
}

let watcher = null;
let processingQueue = new Set();
let processingTimeout = null;

/**
 * Processes a file or folder change
 * Uses debouncing to batch rapid changes
 */
async function processChange(filePath) {
  const normalizedPath = path.resolve(filePath);
  
  // Add to processing queue
  processingQueue.add(normalizedPath);
  
  // Clear existing timeout
  if (processingTimeout) {
    clearTimeout(processingTimeout);
  }
  
  // Debounce: process changes after 500ms of inactivity
  processingTimeout = setTimeout(async () => {
    const pathsToProcess = Array.from(processingQueue);
    processingQueue.clear();
    
    try {
      // Get all users
      const usersResult = await pool.query('SELECT id FROM users');
      const userIds = usersResult.rows.map(row => row.id);
      
      if (userIds.length === 0) return;
      
      for (const filePathToProcess of pathsToProcess) {
        try {
          await handleFileChange(filePathToProcess, userIds);
        } catch (error) {
          // Continue processing other files on error
        }
      }
    } catch (error) {
      logger.error('[Custom Drive] Error processing changes:', error);
    }
  }, 500);
}

/**
 * Handles a single file/folder change
 */
async function handleFileChange(filePath, userIds) {
  try {
    const stats = await fs.stat(filePath).catch(() => null);
    
    if (!stats) {
      await handleDeletion(filePath, userIds);
      return;
    }
    
    const parentDir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    // Use case-insensitive path comparison
    const normalizedParentDir = path.resolve(parentDir).toLowerCase();
    const parentResult = await pool.query(
      'SELECT id, user_id FROM files WHERE LOWER(path) = $1 AND user_id = ANY($2::text[]) AND type = $3',
      [normalizedParentDir, userIds, 'folder']
    );
    
    const parentFolderIds = {};
    userIds.forEach(userId => {
      const parentRow = parentResult.rows.find(r => r.user_id === userId);
      parentFolderIds[userId] = parentRow?.id || null;
    });
    
    if (stats.isDirectory()) {
      await batchCreateOrUpdateFolders(fileName, parentFolderIds, userIds, filePath);
    } else if (stats.isFile()) {
      const mimeType = getMimeType(fileName);
      await batchCreateOrUpdateFiles(fileName, stats.size, mimeType, filePath, parentFolderIds, userIds);
    }
  } catch (error) {
    // Continue on error
  }
}

/**
 * Handles file/folder deletion
 */
async function handleDeletion(filePath, userIds) {
  try {
    const pathSeparator = path.sep === '\\' ? '\\\\' : path.sep;
    const normalizedPath = path.resolve(filePath).toLowerCase();

    logger.info(`[Custom Drive] File deleted from disk: ${filePath}`);

    // Hard delete from database (remove entries completely)
    const result1 = await pool.query(
      'DELETE FROM files WHERE LOWER(path) = $1 AND user_id = ANY($2::text[])',
      [normalizedPath, userIds]
    );

    // Delete children (case-insensitive, ESCAPE '' to handle backslashes)
    const result2 = await pool.query(
      `DELETE FROM files
       WHERE LOWER(path) LIKE $1 || $2 || '%' ESCAPE '' AND user_id = ANY($3::text[])`,
      [normalizedPath, pathSeparator, userIds]
    );

    const totalDeleted = result1.rowCount + result2.rowCount;
    if (totalDeleted > 0) {
      logger.info(`[Custom Drive] Removed ${totalDeleted} entries from database`);
    }
  } catch (error) {
    logger.error(`[Custom Drive] Error deleting file from database:`, error.message);
  }
}

/**
 * Starts the custom drive file watcher if enabled
 * Uses real-time file system watching instead of periodic scanning
 */
async function startCustomDriveScanner() {
  const customDriveEnabled = process.env.CUSTOM_DRIVE === 'yes';
  const customDrivePath = process.env.CUSTOM_DRIVE_PATH;

  if (!customDriveEnabled || !customDrivePath) {
    return;
  }

  const normalizedPath = path.resolve(customDrivePath);

  try {
    await fs.stat(normalizedPath);

    // Check if this is the first scan by looking for any existing custom drive files (case-insensitive)
    // Use ESCAPE '' to disable backslash escaping in LIKE pattern (Windows paths have backslashes)
    const normalizedPathLower = normalizedPath.toLowerCase();
    const existingFiles = await pool.query(
      "SELECT COUNT(*) as count FROM files WHERE path IS NOT NULL AND LOWER(path) LIKE $1 || '%' ESCAPE ''",
      [normalizedPathLower]
    );

    const isFirstScan = parseInt(existingFiles.rows[0].count) === 0;

    logger.info(`[Custom Drive] Found ${existingFiles.rows[0].count} existing files`);

    if (isFirstScan) {
      logger.info('[Custom Drive] First scan detected, performing full scan...');
      await scanCustomDrive(customDrivePath);
      logger.info('[Custom Drive] Initial scan complete');
    } else {
      logger.info('[Custom Drive] Existing data found, using full scan to ensure consistency...');
      await scanCustomDrive(customDrivePath);
      logger.info('[Custom Drive] Full scan complete');
    }

    // Start file watcher for real-time updates
    watcher = chokidar.watch(normalizedPath, {
      ignored: [
        /(^|[\/\\])\../, // ignore dotfiles
        /node_modules/, // ignore node_modules
        /\.git/, // ignore .git
      ],
      persistent: true,
      ignoreInitial: true, // Don't trigger events for existing files
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1 second after file stops changing
        pollInterval: 500
      },
      depth: 99, // Watch all subdirectories
      usePolling: false, // Use native events (faster, but set to true for network drives)
      ignorePermissionErrors: true, // Ignore permission errors
      atomic: true, // Handle atomic writes better
    });

    watcher.on('add', (filePath) => {
      processChange(filePath).catch(err => {
        logger.error(`[Custom Drive] Error processing add event for ${filePath}:`, err.message);
      });
    });

    watcher.on('change', (filePath) => {
      processChange(filePath).catch(err => {
        logger.error(`[Custom Drive] Error processing change event for ${filePath}:`, err.message);
      });
    });

    watcher.on('addDir', (filePath) => {
      processChange(filePath).catch(err => {
        logger.error(`[Custom Drive] Error processing addDir event for ${filePath}:`, err.message);
      });
    });

    watcher.on('unlink', (filePath) => {
      processChange(filePath).catch(err => {
        logger.error(`[Custom Drive] Error processing unlink event for ${filePath}:`, err.message);
      });
    });

    watcher.on('unlinkDir', (filePath) => {
      processChange(filePath).catch(err => {
        logger.error(`[Custom Drive] Error processing unlinkDir event for ${filePath}:`, err.message);
      });
    });

    // Handle errors gracefully
    watcher.on('error', (error) => {
      // Ignore EPERM errors (permission issues) - these are common on Windows
      if (error.code === 'EPERM') {
        logger.info('[Custom Drive] Skipping file due to permission restriction');
        return;
      }

      // Ignore ENOENT errors (file not found) - these happen during rapid deletions
      if (error.code === 'ENOENT') {
        logger.info('[Custom Drive] File no longer exists, ignoring');
        return;
      }

      // Log other errors
      logger.error('[Custom Drive] Watcher error:', error.code || error.message);
    });

    watcher.on('ready', () => {
      logger.info('[Custom Drive] File system watcher ready');
    });

  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error(`[Custom Drive] Path does not exist: ${normalizedPath}`);
    } else {
      logger.error('[Custom Drive] Failed to start watcher:', error);
    }
  }
}

/**
 * Stops the file system watcher (useful for testing or graceful shutdown)
 */
function stopCustomDriveScanner() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
  
  processingQueue.clear();
}

module.exports = {
  scanCustomDrive,
  syncCustomDrive,
  startCustomDriveScanner,
  stopCustomDriveScanner,
};

