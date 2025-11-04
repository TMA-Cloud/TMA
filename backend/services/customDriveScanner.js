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
      console.error(`[Custom Drive] Path is not a directory: ${normalizedPath}`);
      return;
    }
  } catch (error) {
    console.error(`[Custom Drive] Cannot access directory: ${normalizedPath}`, error.message);
    return;
  }

  try {
    const usersResult = await pool.query('SELECT id FROM users');
    const userIds = usersResult.rows.map(row => row.id);

    if (userIds.length === 0) {
      return;
    }

    const folderMap = new Map();
    await scanDirectory(normalizedPath, null, userIds, folderMap);
  } catch (error) {
    console.error('[Custom Drive] Error during scan:', error);
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
        // Continue with other entries on error
      }
    }
  } catch (error) {
    // Skip directories we can't read (permissions, etc.)
  }
}

/**
 * Batch creates or updates folder entries for multiple users
 * @param {string} name - Folder name
 * @param {Object<string, string|null>} parentIds - Map of userId -> parentId
 * @param {string[]} userIds - Array of user IDs
 * @param {string} absolutePath - Absolute path of the folder
 * @returns {Promise<Object<string, string>>} Map of userId -> folderId
 */
async function batchCreateOrUpdateFolders(name, parentIds, userIds, absolutePath) {
  // Batch check existing folders for all users
  const existingResult = await pool.query(
    'SELECT id, user_id FROM files WHERE path = $1 AND user_id = ANY($2::text[]) AND type = $3',
    [absolutePath, userIds, 'folder']
  );
  
  const existingMap = new Map();
  const updateIds = [];
  
  existingResult.rows.forEach((row) => {
    existingMap.set(row.user_id, row.id);
    updateIds.push(row.id);
  });
  
  if (updateIds.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < updateIds.length; i++) {
        const userId = existingResult.rows.find(r => r.id === updateIds[i])?.user_id;
        if (userId) {
          await client.query(
            'UPDATE files SET name = $1, parent_id = $2 WHERE id = $3',
            [name, parentIds[userId] || null, updateIds[i]]
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  const userIdsToInsert = userIds.filter(userId => !existingMap.has(userId));
  if (userIdsToInsert.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const folderIdsMap = new Map(existingMap);
      
      for (const userId of userIdsToInsert) {
        const id = generateId(16);
        await client.query(
          'INSERT INTO files(id, name, type, parent_id, user_id, path) VALUES($1, $2, $3, $4, $5, $6)',
          [id, name, 'folder', parentIds[userId] || null, userId, absolutePath]
        );
        folderIdsMap.set(userId, id);
      }
      
      await client.query('COMMIT');
      return folderIdsMap;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  return existingMap;
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
 * @returns {Promise<Object<string, string>>} Map of userId -> fileId
 */
async function batchCreateOrUpdateFiles(name, size, mimeType, absolutePath, parentIds, userIds) {
  // Batch check existing files for all users
  const existingResult = await pool.query(
    'SELECT id, user_id, size, modified FROM files WHERE path = $1 AND user_id = ANY($2::text[]) AND type = $3',
    [absolutePath, userIds, 'file']
  );
  
  const existingMap = new Map();
  const updateIds = [];
  const updateData = [];
  
  existingResult.rows.forEach((row) => {
    existingMap.set(row.user_id, {
      id: row.id,
      size: parseInt(row.size),
      modified: row.modified
    });
    updateIds.push(row.id);
    updateData.push({
      id: row.id,
      size: row.size,
      needsUpdate: parseInt(row.size) !== size
    });
  });
  
  if (updateIds.length > 0) {
    const needsUpdateIds = updateData.filter(d => d.needsUpdate).map(d => d.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      if (needsUpdateIds.length > 0) {
        await client.query(
          'UPDATE files SET size = $1, modified = NOW(), mime_type = $2, name = $3 WHERE id = ANY($4::text[])',
          [size, mimeType, name, needsUpdateIds]
        );
        
        for (const row of existingResult.rows) {
          if (needsUpdateIds.includes(row.id)) {
            await client.query(
              'UPDATE files SET parent_id = $1 WHERE id = $2',
              [parentIds[row.user_id] || null, row.id]
            );
          }
        }
      }
      
      const noSizeUpdateIds = updateIds.filter(id => !needsUpdateIds.includes(id));
      if (noSizeUpdateIds.length > 0) {
        await client.query(
          'UPDATE files SET name = $1 WHERE id = ANY($2::text[])',
          [name, noSizeUpdateIds]
        );
        
        for (const row of existingResult.rows) {
          if (noSizeUpdateIds.includes(row.id)) {
            await client.query(
              'UPDATE files SET parent_id = $1 WHERE id = $2',
              [parentIds[row.user_id] || null, row.id]
            );
          }
        }
      }
      
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  const userIdsToInsert = userIds.filter(userId => !existingMap.has(userId));
  if (userIdsToInsert.length > 0) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const fileIdsMap = new Map(existingMap);
      
      for (const userId of userIdsToInsert) {
        const id = generateId(16);
        await client.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1, $2, $3, $4, $5, $6, $7, $8)',
          [id, name, 'file', size, mimeType, absolutePath, parentIds[userId] || null, userId]
        );
        fileIdsMap.set(userId, { id });
      }
      
      await client.query('COMMIT');
      return fileIdsMap;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  
  return existingMap;
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
      console.error(`[Custom Drive] Path is not a directory: ${normalizedPath}`);
      return;
    }
  } catch (error) {
    console.error(`[Custom Drive] Cannot access directory: ${normalizedPath}`, error.message);
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
    const dbResult = await pool.query(
      "SELECT id, name, type, size, modified, path FROM files WHERE path IS NOT NULL AND path LIKE $1 || '%'",
      [normalizedPath]
    );
    
    for (const row of dbResult.rows) {
      if (row.path && path.isAbsolute(row.path)) {
        dbEntries.set(row.path, row);
      }
    }

    // Recursively scan and sync
    await syncDirectory(normalizedPath, null, userIds, dbEntries);

  } catch (error) {
    console.error('[Custom Drive] Error during sync:', error);
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
      console.error('[Custom Drive] Error processing changes:', error);
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
    
    const parentResult = await pool.query(
      'SELECT id, user_id FROM files WHERE path = $1 AND user_id = ANY($2::text[]) AND type = $3',
      [parentDir, userIds, 'folder']
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
    
    await pool.query(
      'UPDATE files SET deleted_at = NOW() WHERE path = $1 AND user_id = ANY($2::text[]) AND deleted_at IS NULL',
      [filePath, userIds]
    );
    
    await pool.query(
      `UPDATE files SET deleted_at = NOW() 
       WHERE path LIKE $1 || $2 || '%' AND user_id = ANY($3::text[]) AND deleted_at IS NULL`,
      [filePath, pathSeparator, userIds]
    );
  } catch (error) {
    // Continue on error
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
    await scanCustomDrive(customDrivePath);
    
    watcher = chokidar.watch(normalizedPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true, // Don't trigger events for existing files
      awaitWriteFinish: {
        stabilityThreshold: 1000, // Wait 1 second after file stops changing
        pollInterval: 500
      },
      depth: 99, // Watch all subdirectories
      usePolling: false, // Use native events (faster, but set to true for network drives)
    });
    
    watcher.on('add', processChange);
    watcher.on('change', processChange);
    watcher.on('addDir', processChange);
    watcher.on('unlink', processChange);
    watcher.on('unlinkDir', processChange);
    
    // Handle errors
    watcher.on('error', (error) => {
      console.error('[Custom Drive] Watcher error:', error);
    });
    
    watcher.on('ready', () => {
      console.log('[Custom Drive] File system watcher ready');
    });
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.error(`[Custom Drive] Path does not exist: ${normalizedPath}`);
    } else {
      console.error('[Custom Drive] Failed to start watcher:', error);
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

