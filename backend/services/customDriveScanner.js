const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const debounce = require('lodash.debounce');
const mime = require('mime-types');
const pool = require('../config/db');
const { generateId } = require('../utils/id');
const { logger } = require('../config/logger');
const { getUsersWithCustomDrive } = require('../models/user.model');
const { publishFileEvent, EventTypes } = require('./fileEvents');
const { invalidateFileCache } = require('../utils/cache');

/**
 * Scans a user's custom drive directory and syncs with database
 * Removes database entries for files/folders that no longer exist on disk
 */
async function scanCustomDrive(customDrivePath, userId) {
  const normalizedPath = path.resolve(customDrivePath);

  try {
    const stat = await fs.stat(normalizedPath);
    if (!stat.isDirectory()) {
      logger.error(`[Custom Drive] Path is not a directory: ${normalizedPath} (user: ${userId})`);
      return;
    }
  } catch (error) {
    logger.error(`[Custom Drive] Cannot access directory: ${normalizedPath} (user: ${userId})`, error.message);
    return;
  }

  try {
    logger.info(`[Custom Drive] Starting scan for user ${userId} at ${normalizedPath}`);

    // Get all existing database entries for this user's custom drive
    const normalizedPathLower = normalizedPath.toLowerCase();
    const dbResult = await pool.query(
      "SELECT id, name, type, parent_id, path FROM files WHERE user_id = $1 AND path IS NOT NULL AND LOWER(path) LIKE $2 || '%' ESCAPE ''",
      [userId, normalizedPathLower]
    );

    // Map database paths to file info
    const dbPathToInfo = new Map();
    for (const row of dbResult.rows) {
      if (row.path && path.isAbsolute(row.path)) {
        dbPathToInfo.set(row.path.toLowerCase(), row);
      }
    }

    // Track paths seen during scan
    const seenPaths = new Set();

    // Scan filesystem
    await scanDirectory(normalizedPath, null, [userId], seenPaths);

    // Remove database entries for files/folders that no longer exist
    const pathsToRemove = Array.from(dbPathToInfo.keys()).filter(path => !seenPaths.has(path));

    if (pathsToRemove.length > 0) {
      logger.info(`[Custom Drive] Removing ${pathsToRemove.length} deleted entry/entries for user ${userId}`);
      const pathSeparator = path.sep === '\\' ? '\\\\' : path.sep;

      for (const pathToRemove of pathsToRemove) {
        try {
          const fileInfo = dbPathToInfo.get(pathToRemove);

          // Delete entry and children
          await pool.query('DELETE FROM files WHERE LOWER(path) = $1 AND user_id = $2', [pathToRemove, userId]);
          await pool.query(`DELETE FROM files WHERE LOWER(path) LIKE $1 || $2 || '%' ESCAPE '' AND user_id = $3`, [
            pathToRemove,
            pathSeparator,
            userId,
          ]);

          // Publish deletion event
          if (fileInfo) {
            await invalidateAndPublishEvent(
              userId,
              fileInfo.parent_id,
              fileInfo.type === 'folder' ? EventTypes.FILE_DELETED : EventTypes.FILE_PERMANENTLY_DELETED,
              {
                id: fileInfo.id,
                name: fileInfo.name,
                parentId: fileInfo.parent_id,
                userId,
                isCustomDrive: true,
              }
            );
          }
        } catch (error) {
          logger.error(`[Custom Drive] Error removing path ${pathToRemove}:`, error.message);
        }
      }
    }

    logger.info(`[Custom Drive] Scan completed successfully for user ${userId}`);
  } catch (error) {
    logger.error(`[Custom Drive] Error during scan for user ${userId}:`, error);
    throw error;
  }
}

/**
 * Recursively scans a directory and inserts files/folders into the database
 */
async function scanDirectory(dirPath, parentFolderIds, userIds, seenPaths) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const normalizedEntryPath = path.resolve(entryPath).toLowerCase();
      seenPaths.add(normalizedEntryPath);

      try {
        const stats = await fs.stat(entryPath);
        const parentIdMap = parentFolderIds || {};

        if (entry.isDirectory()) {
          const { folderIdsMap } = await batchCreateOrUpdateFolders(
            entry.name,
            parentIdMap,
            userIds,
            entryPath,
            stats.mtime
          );

          // Convert Map to object for recursive call
          const folderIds = {};
          for (const userId of userIds) {
            folderIds[userId] = folderIdsMap.get(userId);
          }

          await scanDirectory(entryPath, folderIds, userIds, seenPaths);
        } else if (entry.isFile()) {
          await batchCreateOrUpdateFiles(
            entry.name,
            stats.size,
            getMimeType(entry.name),
            entryPath,
            parentIdMap,
            userIds,
            stats.mtime
          );
        }
      } catch (error) {
        logger.error(`[Custom Drive] Error processing ${entryPath}:`, error.message);
      }
    }
  } catch (error) {
    logger.error(`[Custom Drive] Cannot read directory ${dirPath}:`, error.message);
  }
}

/**
 * Batch creates or updates folder entries for multiple users
 */
async function batchCreateOrUpdateFolders(name, parentIds, userIds, absolutePath, modifiedTime = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const folderIdsMap = new Map();
    const createdMap = new Map();
    const normalizedPath = path.resolve(absolutePath).toLowerCase();
    const originalCasePath = path.resolve(absolutePath);

    for (const userId of userIds) {
      const parentId = parentIds[userId] || null;
      const existing = await client.query(
        'SELECT id, name, parent_id, modified FROM files WHERE LOWER(path) = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
        [normalizedPath, userId, 'folder']
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const nameChanged = row.name !== name;
        const parentChanged = row.parent_id !== parentId;
        const modifiedChanged =
          modifiedTime && (!row.modified || new Date(modifiedTime).valueOf() !== new Date(row.modified).valueOf());

        if (nameChanged || parentChanged || modifiedChanged) {
          const updateFields = modifiedChanged
            ? [
                'UPDATE files SET name = $1, parent_id = $2, modified = $3 WHERE id = $4',
                [name, parentId, modifiedTime, row.id],
              ]
            : ['UPDATE files SET name = $1, parent_id = $2 WHERE id = $3', [name, parentId, row.id]];
          await client.query(updateFields[0], updateFields[1]);
        }
        folderIdsMap.set(userId, row.id);
        createdMap.set(userId, false);
      } else {
        const id = generateId(16);
        const insertQuery = modifiedTime
          ? 'INSERT INTO files(id, name, type, parent_id, user_id, path, modified) VALUES($1, $2, $3, $4, $5, $6, $7)'
          : 'INSERT INTO files(id, name, type, parent_id, user_id, path) VALUES($1, $2, $3, $4, $5, $6)';
        const insertParams = modifiedTime
          ? [id, name, 'folder', parentId, userId, originalCasePath, modifiedTime]
          : [id, name, 'folder', parentId, userId, originalCasePath];
        await client.query(insertQuery, insertParams);
        folderIdsMap.set(userId, id);
        createdMap.set(userId, true);
      }
    }

    await client.query('COMMIT');
    return { folderIdsMap, createdMap };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[Custom Drive] Error in batchCreateOrUpdateFolders:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Batch creates or updates file entries for multiple users
 */
async function batchCreateOrUpdateFiles(name, size, mimeType, absolutePath, parentIds, userIds, modifiedTime = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fileIdsMap = new Map();
    const createdMap = new Map();
    const normalizedPath = path.resolve(absolutePath).toLowerCase();
    const originalCasePath = path.resolve(absolutePath);

    for (const userId of userIds) {
      const parentId = parentIds[userId] || null;
      const existing = await client.query(
        'SELECT id, name, size, mime_type, parent_id, modified FROM files WHERE LOWER(path) = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
        [normalizedPath, userId, 'file']
      );

      if (existing.rows.length > 0) {
        const row = existing.rows[0];
        const nameChanged = row.name !== name;
        const sizeChanged = row.size !== size;
        const mimeChanged = row.mime_type !== mimeType;
        const parentChanged = row.parent_id !== parentId;
        const modifiedChanged =
          modifiedTime && (!row.modified || new Date(modifiedTime).valueOf() !== new Date(row.modified).valueOf());

        if (nameChanged || sizeChanged || mimeChanged || parentChanged || modifiedChanged) {
          const updateQuery = modifiedChanged
            ? 'UPDATE files SET name = $1, size = $2, mime_type = $3, parent_id = $4, modified = $5 WHERE id = $6'
            : 'UPDATE files SET name = $1, size = $2, mime_type = $3, parent_id = $4 WHERE id = $5';
          const updateParams = modifiedChanged
            ? [name, size, mimeType, parentId, modifiedTime, row.id]
            : [name, size, mimeType, parentId, row.id];
          await client.query(updateQuery, updateParams);
        }
        fileIdsMap.set(userId, { id: row.id });
        createdMap.set(userId, false);
      } else {
        const id = generateId(16);
        const insertQuery = modifiedTime
          ? 'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)'
          : 'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1, $2, $3, $4, $5, $6, $7, $8)';
        const insertParams = modifiedTime
          ? [id, name, 'file', size, mimeType, originalCasePath, parentId, userId, modifiedTime]
          : [id, name, 'file', size, mimeType, originalCasePath, parentId, userId];
        await client.query(insertQuery, insertParams);
        fileIdsMap.set(userId, { id });
        createdMap.set(userId, true);
      }
    }

    await client.query('COMMIT');
    return { fileIdsMap, createdMap };
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('[Custom Drive] Error in batchCreateOrUpdateFiles:', error);
    throw error;
  } finally {
    client.release();
  }
}

function getMimeType(filename) {
  return mime.lookup(filename) || 'application/octet-stream';
}

/**
 * Invalidates cache and publishes event (common pattern)
 */
async function invalidateAndPublishEvent(userId, parentId, eventType, eventData) {
  await invalidateFileCache(userId, parentId);
  await publishFileEvent(eventType, eventData);
}

// Watcher state
const watchers = new Map();
const processingQueues = new Map();
const debouncedProcessors = new Map();

/**
 * Process queued changes for a user
 */
async function processQueuedChanges(userId) {
  const processingQueue = processingQueues.get(userId);
  if (!processingQueue || processingQueue.size === 0) {
    return;
  }

  const pathsToProcess = Array.from(processingQueue);
  processingQueue.clear();

  for (const filePathToProcess of pathsToProcess) {
    try {
      await handleFileChange(filePathToProcess, [userId]);
    } catch (error) {
      logger.error(`[Custom Drive] Error processing ${filePathToProcess} for user ${userId}:`, error.message);
    }
  }
}

/**
 * Queues a file change for processing (debounced)
 */
function processChange(filePath, userId) {
  const normalizedPath = path.resolve(filePath);

  if (!processingQueues.has(userId)) {
    processingQueues.set(userId, new Set());
  }
  processingQueues.get(userId).add(normalizedPath);

  if (!debouncedProcessors.has(userId)) {
    debouncedProcessors.set(
      userId,
      debounce(() => processQueuedChanges(userId), 500, {
        leading: false,
        trailing: true,
        maxWait: 2000,
      })
    );
  }

  debouncedProcessors.get(userId)();
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
      const { folderIdsMap, createdMap } = await batchCreateOrUpdateFolders(
        fileName,
        parentFolderIds,
        userIds,
        filePath,
        stats.mtime
      );

      for (const userId of userIds) {
        const folderId = folderIdsMap.get(userId);
        const parentId = parentFolderIds[userId] || null;
        if (folderId) {
          const eventType = createdMap.get(userId) ? EventTypes.FOLDER_CREATED : EventTypes.FILE_UPDATED;

          await invalidateAndPublishEvent(userId, parentId, eventType, {
            id: folderId,
            name: fileName,
            parentId,
            userId,
            isCustomDrive: true,
          });
        }
      }
    } else if (stats.isFile()) {
      const mimeType = getMimeType(fileName);
      const { fileIdsMap, createdMap } = await batchCreateOrUpdateFiles(
        fileName,
        stats.size,
        mimeType,
        filePath,
        parentFolderIds,
        userIds,
        stats.mtime
      );

      for (const userId of userIds) {
        const fileEntry = fileIdsMap.get(userId);
        const parentId = parentFolderIds[userId] || null;
        if (fileEntry) {
          const eventType = createdMap.get(userId) ? EventTypes.FILE_UPLOADED : EventTypes.FILE_UPDATED;

          await invalidateAndPublishEvent(userId, parentId, eventType, {
            id: fileEntry.id,
            name: fileName,
            size: stats.size,
            mimeType,
            parentId,
            userId,
            isCustomDrive: true,
          });
        }
      }
    }
  } catch (error) {
    logger.error(`[Custom Drive] Error handling file change ${filePath}:`, error.message);
  }
}

/**
 * Handles file/folder deletion
 */
async function handleDeletion(filePath, userIds) {
  try {
    const normalizedPath = path.resolve(filePath).toLowerCase();
    const pathSeparator = path.sep === '\\' ? '\\\\' : path.sep;

    logger.info(`[Custom Drive] File deleted from disk: ${filePath}`);

    // Query file info BEFORE deletion - we need id, parent_id, and type to publish
    // the correct SSE event. If we delete first, we lose this information and the
    // frontend won't know which specific item to remove from the UI.
    const fileInfoResult = await pool.query(
      'SELECT id, name, type, parent_id, user_id FROM files WHERE LOWER(path) = $1 AND user_id = ANY($2::text[])',
      [normalizedPath, userIds]
    );

    // Delete entry and children
    await pool.query('DELETE FROM files WHERE LOWER(path) = $1 AND user_id = ANY($2::text[])', [
      normalizedPath,
      userIds,
    ]);
    await pool.query(
      `DELETE FROM files WHERE LOWER(path) LIKE $1 || $2 || '%' ESCAPE '' AND user_id = ANY($3::text[])`,
      [normalizedPath, pathSeparator, userIds]
    );

    // Publish deletion events
    for (const row of fileInfoResult.rows) {
      await invalidateAndPublishEvent(
        row.user_id,
        row.parent_id,
        row.type === 'folder' ? EventTypes.FILE_DELETED : EventTypes.FILE_PERMANENTLY_DELETED,
        {
          id: row.id,
          name: row.name,
          parentId: row.parent_id,
          userId: row.user_id,
          isCustomDrive: true,
        }
      );
    }
  } catch (error) {
    logger.error(`[Custom Drive] Error deleting file from database:`, error.message);
  }
}

/**
 * Starts a file watcher for a specific user's custom drive
 */
async function startUserWatcher(userId, customDrivePath) {
  const normalizedPath = path.resolve(customDrivePath);

  try {
    await fs.stat(normalizedPath);

    // Always perform full scan on startup to ensure consistency
    logger.info(`[Custom Drive] User ${userId}: Performing initial scan...`);
    await scanCustomDrive(customDrivePath, userId);
    logger.info(`[Custom Drive] User ${userId}: Initial scan complete`);

    // Start file watcher for real-time updates
    // Note: depth: 99 allows watching deeply nested directories. For very large directories
    // (e.g., 500k+ files), this may consume significant RAM. This is acceptable for
    // self-hosted custom drive usage, but be aware of resource usage.
    // Only ignore specific system folders, not all folders starting with dots
    // This allows user-created folders like .FOLDER to be watched
    const watcher = chokidar.watch(normalizedPath, {
      ignored: [/node_modules/, /\.git$/, /\.git\//, /\.DS_Store$/, /\.vscode$/, /\.idea$/, /Thumbs\.db$/],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 500,
      },
      depth: 99,
      usePolling: false,
      ignorePermissionErrors: true,
      atomic: true,
    });

    watcher.on('add', filePath => {
      logger.info(`[Custom Drive] User ${userId}: File added: ${filePath}`);
      processChange(filePath, userId);
    });

    watcher.on('change', filePath => {
      logger.info(`[Custom Drive] User ${userId}: File changed: ${filePath}`);
      processChange(filePath, userId);
    });

    watcher.on('addDir', filePath => {
      processChange(filePath, userId);
    });

    watcher.on('unlink', filePath => {
      logger.info(`[Custom Drive] User ${userId}: File deleted: ${filePath}`);
      processChange(filePath, userId);
    });

    watcher.on('unlinkDir', filePath => {
      logger.info(`[Custom Drive] User ${userId}: Folder deleted: ${filePath}`);
      processChange(filePath, userId);
    });

    watcher.on('error', error => {
      if (error.code === 'EPERM' || error.code === 'ENOENT') {
        return; // Ignore common errors
      }
      logger.error(`[Custom Drive] User ${userId}: Watcher error:`, error.code || error.message);
    });

    watcher.on('ready', () => {
      logger.info(`[Custom Drive] User ${userId}: File system watcher ready for ${normalizedPath}`);
    });

    watchers.set(userId, watcher);
  } catch (error) {
    if (error.code === 'ENOENT') {
      logger.error(`[Custom Drive] User ${userId}: Path does not exist: ${normalizedPath}`);
    } else {
      logger.error(`[Custom Drive] User ${userId}: Failed to start watcher:`, error);
    }
  }
}

/**
 * Starts custom drive file watchers for all users with custom drive enabled
 */
async function startCustomDriveScanner() {
  try {
    const users = await getUsersWithCustomDrive();

    if (users.length === 0) {
      logger.info('[Custom Drive] No users with custom drive enabled');
      return;
    }

    logger.info(`[Custom Drive] Starting watchers for ${users.length} user(s)`);

    for (const user of users) {
      await startUserWatcher(user.id, user.custom_drive_path);
    }

    logger.info(`[Custom Drive] Started ${watchers.size} watcher(s)`);
  } catch (error) {
    logger.error('[Custom Drive] Failed to start scanners:', error);
  }
}

/**
 * Stops a specific user's file system watcher
 */
function stopUserWatcher(userId) {
  const watcher = watchers.get(userId);
  if (watcher) {
    watcher.close();
    watchers.delete(userId);
  }

  const debounced = debouncedProcessors.get(userId);
  if (debounced) {
    debounced.cancel();
    debouncedProcessors.delete(userId);
  }

  const queue = processingQueues.get(userId);
  if (queue) {
    queue.clear();
    processingQueues.delete(userId);
  }
}

/**
 * Stops all file system watchers
 */
function stopCustomDriveScanner() {
  for (const watcher of watchers.values()) {
    watcher.close();
  }
  watchers.clear();

  for (const debounced of debouncedProcessors.values()) {
    debounced.cancel();
  }
  debouncedProcessors.clear();

  for (const queue of processingQueues.values()) {
    queue.clear();
  }
  processingQueues.clear();
}

/**
 * Restart watcher for a specific user
 */
async function restartUserWatcher(userId, customDrivePath) {
  stopUserWatcher(userId);

  if (customDrivePath) {
    await startUserWatcher(userId, customDrivePath);
    logger.info(`[Custom Drive] Restarted watcher for user ${userId}`);
  } else {
    logger.info(`[Custom Drive] Stopped watcher for user ${userId}`);
  }
}

module.exports = {
  scanCustomDrive,
  startCustomDriveScanner,
  stopCustomDriveScanner,
  restartUserWatcher,
};
