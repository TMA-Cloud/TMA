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
 * Converts a pattern string to a regex
 * @param {string} pattern - Pattern string (may contain wildcards)
 * @returns {RegExp|null} Compiled regex or null if invalid
 */
function patternToRegex(pattern) {
  try {
    // If pattern looks like a regex (starts and ends with /), compile it
    if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
      return new RegExp(pattern.slice(1, -1));
    }

    const hasWildcard = pattern.includes('*');

    if (hasWildcard) {
      // Convert * to .* for regex, but escape other special characters
      const placeholder = '__WILDCARD_PLACEHOLDER__';
      let processed = pattern.replace(/\*/g, placeholder);
      processed = processed.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      processed = processed.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '.*');
      return new RegExp(processed, 'i');
    } else {
      // No wildcard - match exactly as complete path segment
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pathSepEscaped = path.sep === '\\' ? '\\\\' : path.sep;
      return new RegExp(`(^|${pathSepEscaped})${escaped}($|${pathSepEscaped})`);
    }
  } catch (error) {
    logger.warn(`[Custom Drive] Invalid ignore pattern "${pattern}": ${error.message}`);
    return null;
  }
}

/**
 * Tests if a regex matches any of the given paths
 * @param {RegExp} regex - Compiled regex pattern
 * @param {string} filePath - Full file path
 * @param {string} relativePath - Relative path from base
 * @param {string} fileName - Just the filename
 * @returns {boolean} True if pattern matches
 */
function testPattern(regex, filePath, relativePath, fileName) {
  try {
    const normalizedPath = filePath.toLowerCase();
    const normalizedRelative = relativePath.toLowerCase();
    const normalizedFileName = fileName.toLowerCase();

    return (
      regex.test(filePath) ||
      regex.test(relativePath) ||
      regex.test(normalizedPath) ||
      regex.test(normalizedRelative) ||
      regex.test(fileName) ||
      regex.test(normalizedFileName)
    );
  } catch (error) {
    logger.warn(`[Custom Drive] Error testing ignore pattern: ${error.message}`);
    return false;
  }
}

/**
 * Builds ignore function from patterns for chokidar
 * @param {string[]} patterns - Array of ignore patterns
 * @param {string} basePath - Base path to resolve relative patterns
 * @returns {Function|null} Ignore function for chokidar or null
 */
function buildIgnoreFunction(patterns, basePath) {
  if (!patterns || patterns.length === 0) {
    return null;
  }

  const regexPatterns = patterns.map(patternToRegex).filter(p => p !== null);

  if (regexPatterns.length === 0) {
    return null;
  }

  return filePath => {
    const relativePath = path.relative(basePath, filePath);
    const fileName = path.basename(filePath);
    return regexPatterns.some(regex => testPattern(regex, filePath, relativePath, fileName));
  };
}

/**
 * Checks if a path should be ignored
 * @param {string} filePath - Full file path
 * @param {string} basePath - Base custom drive path
 * @param {string[]} ignorePatterns - Array of ignore patterns
 * @returns {boolean} True if path should be ignored
 */
function shouldIgnorePath(filePath, basePath, ignorePatterns) {
  if (!ignorePatterns || ignorePatterns.length === 0 || !basePath) {
    return false;
  }

  const relativePath = path.relative(basePath, filePath);
  const fileName = path.basename(filePath);

  for (const pattern of ignorePatterns) {
    const regex = patternToRegex(pattern);
    if (regex && testPattern(regex, filePath, relativePath, fileName)) {
      return true;
    }
  }

  return false;
}

/**
 * Scans a user's custom drive directory and syncs with database
 * Removes database entries for files/folders that no longer exist on disk
 * IMPORTANT: Uses agent API for Docker compatibility (paths exist on host, not in container)
 */
async function scanCustomDrive(customDrivePath, userId, ignorePatterns = []) {
  const normalizedPath = path.resolve(customDrivePath);

  // Check if agent is configured - if so, use agent API for all operations
  const { getAgentSettings } = require('../models/user.model');
  const agentSettings = await getAgentSettings();
  const useAgent = agentSettings && agentSettings.url;

  try {
    if (useAgent) {
      // Use agent API to check if path exists and is a directory
      const { agentStatPath } = require('../utils/agentFileOperations');
      const stat = await agentStatPath(normalizedPath);
      if (!stat.isDir) {
        logger.error(`[Custom Drive] Path is not a directory: ${normalizedPath} (user: ${userId})`);
        return;
      }
    } else {
      // Direct filesystem access (non-Docker setup)
      const stat = await fs.stat(normalizedPath);
      if (!stat.isDirectory()) {
        logger.error(`[Custom Drive] Path is not a directory: ${normalizedPath} (user: ${userId})`);
        return;
      }
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

    // Scan filesystem (via agent if configured, otherwise direct access)
    await scanDirectory(normalizedPath, null, [userId], seenPaths, ignorePatterns, normalizedPath, useAgent);

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
 * @param {boolean} useAgent - If true, use agent API; if false, use direct filesystem access
 */
async function scanDirectory(
  dirPath,
  parentFolderIds,
  userIds,
  seenPaths,
  ignorePatterns = [],
  basePath = null,
  useAgent = false
) {
  try {
    let entries = [];

    if (useAgent) {
      // Use agent API to list directory
      const { agentListDirectory } = require('../utils/agentFileOperations');
      const listing = await agentListDirectory(dirPath);
      entries = listing.map(item => ({
        name: item.Name || item.name,
        isDirectory: () => item.IsDir || item.isDir || false,
        isFile: () => !(item.IsDir || item.isDir),
        path: item.Path || item.path,
        size: item.Size || item.size || 0,
        modTime: item.ModTime || item.modTime || item.modified,
      }));
    } else {
      // Direct filesystem access
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    }

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      const normalizedEntryPath = path.resolve(entryPath).toLowerCase();

      // Check if this path should be ignored
      if (basePath && shouldIgnorePath(entryPath, basePath, ignorePatterns)) {
        continue;
      }

      seenPaths.add(normalizedEntryPath);

      try {
        let stats;
        let mtime;

        if (useAgent) {
          // For agent, we already have the info from the listing
          // Use entry data directly (from agentListDirectory response)
          const isDir = entry.isDirectory();
          stats = {
            isDirectory: () => isDir,
            isFile: () => !isDir,
            size: entry.size || 0,
            mtime: entry.modTime ? new Date(entry.modTime) : new Date(),
          };
          mtime = stats.mtime;
        } else {
          // Direct filesystem access
          stats = await fs.stat(entryPath);
          mtime = stats.mtime;
        }

        const parentIdMap = parentFolderIds || {};

        if (stats.isDirectory()) {
          const { folderIdsMap } = await batchCreateOrUpdateFolders(entry.name, parentIdMap, userIds, entryPath, mtime);

          // Convert Map to object for recursive call
          const folderIds = {};
          for (const userId of userIds) {
            folderIds[userId] = folderIdsMap.get(userId);
          }

          await scanDirectory(entryPath, folderIds, userIds, seenPaths, ignorePatterns, basePath, useAgent);
        } else if (stats.isFile()) {
          await batchCreateOrUpdateFiles(
            entry.name,
            stats.size,
            getMimeType(entry.name),
            entryPath,
            parentIdMap,
            userIds,
            mtime
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
    const originalCasePath = path.resolve(absolutePath);

    for (const userId of userIds) {
      const parentId = parentIds[userId] || null;
      const id = generateId(16);

      // CTE Upsert query using ON CONFLICT: matches the unique index (path, user_id, type) WHERE path IS NOT NULL
      // First check if row exists, then upsert and return whether it was existing
      const upsertQuery = modifiedTime
        ? `
          WITH existing_check AS (
            SELECT id FROM files 
            WHERE path = $6 AND user_id = $5 AND type = $3 AND deleted_at IS NULL
          ),
          upserted AS (
            INSERT INTO files(id, name, type, parent_id, user_id, path, modified)
            VALUES($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (path, user_id, type) WHERE path IS NOT NULL
            DO UPDATE SET
              name = EXCLUDED.name,
              parent_id = EXCLUDED.parent_id,
              modified = EXCLUDED.modified
            WHERE files.name IS DISTINCT FROM EXCLUDED.name
               OR files.parent_id IS DISTINCT FROM EXCLUDED.parent_id
               OR files.modified IS DISTINCT FROM EXCLUDED.modified
            RETURNING id
          )
          SELECT 
            COALESCE((SELECT id FROM upserted), (SELECT id FROM existing_check)) AS id,
            EXISTS(SELECT 1 FROM existing_check) AS was_existing
        `
        : `
          WITH existing_check AS (
            SELECT id FROM files 
            WHERE path = $6 AND user_id = $5 AND type = $3 AND deleted_at IS NULL
          ),
          upserted AS (
            INSERT INTO files(id, name, type, parent_id, user_id, path)
            VALUES($1, $2, $3, $4, $5, $6)
            ON CONFLICT (path, user_id, type) WHERE path IS NOT NULL
            DO UPDATE SET
              name = EXCLUDED.name,
              parent_id = EXCLUDED.parent_id
            WHERE files.name IS DISTINCT FROM EXCLUDED.name
               OR files.parent_id IS DISTINCT FROM EXCLUDED.parent_id
            RETURNING id
          )
          SELECT 
            COALESCE((SELECT id FROM upserted), (SELECT id FROM existing_check)) AS id,
            EXISTS(SELECT 1 FROM existing_check) AS was_existing
        `;

      const upsertParams = modifiedTime
        ? [id, name, 'folder', parentId, userId, originalCasePath, modifiedTime]
        : [id, name, 'folder', parentId, userId, originalCasePath];

      const result = await client.query(upsertQuery, upsertParams);
      const row = result.rows[0];

      if (row && row.id) {
        folderIdsMap.set(userId, row.id);
        createdMap.set(userId, !row.was_existing);
      } else {
        // Fallback: query to get the id if upsert didn't return it
        const fallbackResult = await client.query(
          'SELECT id FROM files WHERE path = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
          [originalCasePath, userId, 'folder']
        );
        if (fallbackResult.rows[0]) {
          folderIdsMap.set(userId, fallbackResult.rows[0].id);
          createdMap.set(userId, false);
        }
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
    const originalCasePath = path.resolve(absolutePath);

    for (const userId of userIds) {
      const parentId = parentIds[userId] || null;
      const id = generateId(16);

      // CTE Upsert query using ON CONFLICT: matches the unique index (path, user_id, type) WHERE path IS NOT NULL
      // First check if row exists, then upsert and return whether it was existing
      const upsertQuery = modifiedTime
        ? `
          WITH existing_check AS (
            SELECT id FROM files 
            WHERE path = $6 AND user_id = $8 AND type = $3 AND deleted_at IS NULL
          ),
          upserted AS (
            INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, modified)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (path, user_id, type) WHERE path IS NOT NULL
            DO UPDATE SET
              name = EXCLUDED.name,
              size = EXCLUDED.size,
              mime_type = EXCLUDED.mime_type,
              parent_id = EXCLUDED.parent_id,
              modified = EXCLUDED.modified
            WHERE files.name IS DISTINCT FROM EXCLUDED.name
               OR files.size IS DISTINCT FROM EXCLUDED.size
               OR files.mime_type IS DISTINCT FROM EXCLUDED.mime_type
               OR files.parent_id IS DISTINCT FROM EXCLUDED.parent_id
               OR files.modified IS DISTINCT FROM EXCLUDED.modified
            RETURNING id
          )
          SELECT 
            COALESCE((SELECT id FROM upserted), (SELECT id FROM existing_check)) AS id,
            EXISTS(SELECT 1 FROM existing_check) AS was_existing
        `
        : `
          WITH existing_check AS (
            SELECT id FROM files 
            WHERE path = $6 AND user_id = $8 AND type = $3 AND deleted_at IS NULL
          ),
          upserted AS (
            INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (path, user_id, type) WHERE path IS NOT NULL
            DO UPDATE SET
              name = EXCLUDED.name,
              size = EXCLUDED.size,
              mime_type = EXCLUDED.mime_type,
              parent_id = EXCLUDED.parent_id
            WHERE files.name IS DISTINCT FROM EXCLUDED.name
               OR files.size IS DISTINCT FROM EXCLUDED.size
               OR files.mime_type IS DISTINCT FROM EXCLUDED.mime_type
               OR files.parent_id IS DISTINCT FROM EXCLUDED.parent_id
            RETURNING id
          )
          SELECT 
            COALESCE((SELECT id FROM upserted), (SELECT id FROM existing_check)) AS id,
            EXISTS(SELECT 1 FROM existing_check) AS was_existing
        `;

      const upsertParams = modifiedTime
        ? [id, name, 'file', size, mimeType, originalCasePath, parentId, userId, modifiedTime]
        : [id, name, 'file', size, mimeType, originalCasePath, parentId, userId];

      const result = await client.query(upsertQuery, upsertParams);
      const row = result.rows[0];

      if (row && row.id) {
        fileIdsMap.set(userId, { id: row.id });
        createdMap.set(userId, !row.was_existing);
      } else {
        // Fallback: query to get the id if upsert didn't return it
        const fallbackResult = await client.query(
          'SELECT id FROM files WHERE path = $1 AND user_id = $2 AND type = $3 AND deleted_at IS NULL',
          [originalCasePath, userId, 'file']
        );
        if (fallbackResult.rows[0]) {
          fileIdsMap.set(userId, { id: fallbackResult.rows[0].id });
          createdMap.set(userId, false);
        }
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
 * Handles file change notification from agent webhook
 */
async function handleAgentFileChange(changeData) {
  const { event, path: filePath, isDir, size, modTime } = changeData;

  try {
    const normalizedPath = path.resolve(filePath).toLowerCase();

    // Optimized query: find users whose custom drive path is a prefix of the changed file path
    const usersResult = await pool.query(
      `SELECT id, custom_drive_path 
       FROM users 
       WHERE custom_drive_enabled = true 
       AND custom_drive_path IS NOT NULL
       AND $1 LIKE LOWER(custom_drive_path) || '%'`,
      [normalizedPath]
    );

    const userIds = [];
    for (const user of usersResult.rows) {
      const userDrivePath = path.resolve(user.custom_drive_path).toLowerCase();
      const rel = path.relative(userDrivePath, normalizedPath);
      // Ensure file is within user's drive (not parent directory)
      if (!rel.startsWith('..') && rel !== normalizedPath) {
        userIds.push(user.id);
      }
    }

    if (userIds.length === 0) {
      return; // No users watching this path
    }

    // Use provided stats directly (no need to check agent again)
    if (event === 'remove') {
      await handleDeletion(filePath, userIds);
    } else {
      await handleFileChange(filePath, userIds, { isDir, size, modTime });
    }
  } catch (error) {
    logger.error(`[Custom Drive] Error handling agent file change ${filePath}:`, error.message);
  }
}

/**
 * Handles a single file/folder change
 * @param {Object} fileStats - Optional file stats (from agent webhook or direct filesystem)
 */
async function handleFileChange(filePath, userIds, fileStats = null) {
  try {
    let stats = null;

    // Use provided stats if available (from agent webhook - no need to check agent again)
    if (fileStats) {
      stats = {
        isDirectory: () => fileStats.isDir,
        isFile: () => !fileStats.isDir,
        size: fileStats.size || 0,
        mtime: fileStats.modTime || new Date(),
      };
    } else {
      // Fallback: get stats from filesystem (for non-agent scenarios)
      stats = await fs.stat(filePath).catch(() => null);
    }

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
 * IMPORTANT: File watcher (chokidar) won't work in Docker - it requires direct filesystem access
 * The initial scan will work via agent API, but real-time watching is disabled in Docker
 */
async function startUserWatcher(userId, customDrivePath, ignorePatterns = []) {
  const normalizedPath = path.resolve(customDrivePath);

  // Check if agent is configured
  const { getAgentSettings } = require('../models/user.model');
  const agentSettings = await getAgentSettings();
  const useAgent = agentSettings && agentSettings.url;

  try {
    if (useAgent) {
      // Validate path via agent
      const { agentStatPath } = require('../utils/agentFileOperations');
      await agentStatPath(normalizedPath);
    } else {
      // Validate path via direct filesystem access
      await fs.stat(normalizedPath);
    }

    // Always perform full scan on startup to ensure consistency
    logger.info(`[Custom Drive] User ${userId}: Performing initial scan...`);
    await scanCustomDrive(customDrivePath, userId, ignorePatterns);
    logger.info(`[Custom Drive] User ${userId}: Initial scan complete`);

    // In Docker (when agent is used), use agent-based file watching
    if (useAgent) {
      try {
        // Construct webhook URL for agent notifications
        const backendUrl =
          process.env.BACKEND_URL || process.env.API_URL || `http://localhost:${process.env.PORT || 3000}`;
        const webhookUrl = `${backendUrl}/api/agent/webhook`;
        const webhookToken = process.env.AGENT_WEBHOOK_TOKEN || null;

        // Register path with agent for file watching
        const { agentWatchPath } = require('../utils/agentFileOperations');
        await agentWatchPath(normalizedPath, webhookUrl, webhookToken);
        logger.info(`[Custom Drive] User ${userId}: Registered path with agent for file watching: ${normalizedPath}`);
      } catch (error) {
        logger.error(`[Custom Drive] User ${userId}: Failed to register path with agent: ${error.message}`);
      }
      return; // Agent handles watching, no need for chokidar
    }

    // Build ignore function from user-defined patterns
    const ignoreFunction = buildIgnoreFunction(ignorePatterns, normalizedPath);

    // Start file watcher for real-time updates
    // Note: depth: 99 allows watching deeply nested directories. For very large directories
    // (e.g., 500k+ files), this may consume significant RAM. This is acceptable for
    // self-hosted custom drive usage, but be aware of resource usage.
    // Use user-defined ignore patterns (or no ignoring if empty)
    const watcherOptions = {
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
    };

    if (ignoreFunction) {
      watcherOptions.ignored = ignoreFunction;
    }

    const watcher = chokidar.watch(normalizedPath, watcherOptions);

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
    const { getUserCustomDriveSettings } = require('../models/user.model');
    const users = await getUsersWithCustomDrive();

    if (users.length === 0) {
      logger.info('[Custom Drive] No users with custom drive enabled');
      return;
    }

    logger.info(`[Custom Drive] Starting watchers for ${users.length} user(s)`);

    for (const user of users) {
      try {
        const settings = await getUserCustomDriveSettings(user.id);
        await startUserWatcher(user.id, user.custom_drive_path, settings.ignorePatterns || []);
      } catch (error) {
        logger.error(`[Custom Drive] Failed to start watcher for user ${user.id}:`, error.message);
      }
    }

    logger.info(`[Custom Drive] Started ${watchers.size} watcher(s)`);
  } catch (error) {
    logger.error('[Custom Drive] Failed to start scanners:', error);
  }
}

/**
 * Stops a specific user's file system watcher
 */
async function stopUserWatcher(userId) {
  const watcher = watchers.get(userId);
  if (watcher) {
    watcher.close();
    watchers.delete(userId);
  }

  // Unwatch from agent if configured
  try {
    const { getAgentSettings } = require('../models/user.model');
    const { getUserCustomDriveSettings } = require('../models/user.model');
    const agentSettings = await getAgentSettings();
    const useAgent = agentSettings && agentSettings.url;

    if (useAgent) {
      const settings = await getUserCustomDriveSettings(userId);
      if (settings && settings.path) {
        const { agentUnwatchPath } = require('../utils/agentFileOperations');
        await agentUnwatchPath(path.resolve(settings.path));
        logger.info(`[Custom Drive] User ${userId}: Unregistered path from agent: ${settings.path}`);
      }
    }
  } catch (error) {
    logger.error(`[Custom Drive] Error unwatching from agent for user ${userId}:`, error.message);
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
async function restartUserWatcher(userId, customDrivePath, ignorePatterns = []) {
  await stopUserWatcher(userId);

  if (customDrivePath) {
    await startUserWatcher(userId, customDrivePath, ignorePatterns);
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
  handleAgentFileChange,
};
