const pool = require('../config/db');
const { generateId } = require('../utils/id');
const fs = require('fs');
const path = require('path');
const { UPLOAD_DIR, CUSTOM_DRIVE_ENABLED, CUSTOM_DRIVE_PATH } = require('../config/paths');
const { resolveFilePath } = require('../utils/filePath');

const SORT_FIELDS = {
  name: 'name',
  size: 'size',
  modified: 'modified',
  deletedAt: 'deleted_at',
};

function buildOrderClause(sortBy = 'modified', order = 'DESC') {
  const field = SORT_FIELDS[sortBy] || 'modified';
  const dir = order && order.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  // When sorting by size we will compute folder sizes dynamically. However,
  // keep NULL values (shouldn't exist after computing) last just in case.
  const nulls = field === 'size' ? ' NULLS LAST' : '';
  return `ORDER BY ${field} ${dir}${nulls}`;
}

async function calculateFolderSize(id, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, size, type FROM files WHERE id = $1 AND user_id = $2
       UNION ALL
       SELECT f.id, f.size, f.type FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2
     )
     SELECT COALESCE(SUM(size), 0) AS size FROM sub WHERE type = 'file'`,
    [id, userId],
  );
  return parseInt(res.rows[0].size, 10) || 0;
}

async function fillFolderSizes(files, userId) {
  await Promise.all(
    files.map(async (f) => {
      if (f.type === 'folder') {
        f.size = await calculateFolderSize(f.id, userId);
      }
    }),
  );
  return files;
}

async function getFiles(userId, parentId = null, sortBy = 'modified', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared
     FROM files
     WHERE user_id = $1
       AND deleted_at IS NULL
       AND ${parentId ? 'parent_id = $2' : 'parent_id IS NULL'}
     ${orderClause}`,
    parentId ? [userId, parentId] : [userId]
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

async function createFolder(name, parentId = null, userId) {
  const id = generateId(16);
  
  // If custom drive is enabled, create folder in custom drive
  if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
    try {
      // Get the parent folder path
      const parentPath = await getFolderPath(parentId, userId);
      
      // Build the new folder path
      const folderPath = parentPath
        ? path.join(parentPath, name)
        : path.join(CUSTOM_DRIVE_PATH, name);
      
      // Handle duplicate folder names
      let finalPath = folderPath;
      let counter = 1;
      while (await fs.promises.access(finalPath).then(() => true).catch(() => false)) {
        const newName = `${name} (${counter})`;
        finalPath = parentPath
          ? path.join(parentPath, newName)
          : path.join(CUSTOM_DRIVE_PATH, newName);
        counter++;
        if (counter > 10000) {
          throw new Error('Too many duplicate folders');
        }
      }
      
      // Create the folder on disk
      await fs.promises.mkdir(finalPath, { recursive: true });
      
      // Get the actual folder name (in case it was changed due to duplicates)
      const actualName = path.basename(finalPath);
      
      // Store absolute path in database
      const absolutePath = path.resolve(finalPath);
      const result = await pool.query(
        'INSERT INTO files(id, name, type, parent_id, user_id, path) VALUES($1,$2,$3,$4,$5,$6) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
        [id, actualName, 'folder', parentId, userId, absolutePath]
      );
      return result.rows[0];
    } catch (error) {
      // If custom drive creation fails, fall back to regular folder (no path)
      console.error('[File] Error creating folder in custom drive, creating regular folder:', error);
    }
  }
  
  // Regular folder creation (when custom drive is disabled or creation failed)
  const result = await pool.query(
    'INSERT INTO files(id, name, type, parent_id, user_id) VALUES($1,$2,$3,$4,$5) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'folder', parentId, userId]
  );
  return result.rows[0];
}

/**
 * Gets the folder path for a parent folder ID
 * Returns the absolute path if it's a custom drive folder, or null if regular folder
 */
async function getFolderPath(parentId, userId) {
  if (!parentId) {
    return CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH ? CUSTOM_DRIVE_PATH : null;
  }

  const result = await pool.query(
    'SELECT path, type FROM files WHERE id = $1 AND user_id = $2',
    [parentId, userId]
  );

  if (result.rows.length === 0) {
    return CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH ? CUSTOM_DRIVE_PATH : null;
  }

  const folder = result.rows[0];
  
  // If it's a custom drive folder (has absolute path), use it
  if (folder.path && path.isAbsolute(folder.path)) {
    return folder.path;
  }

  // If custom drive is enabled but folder doesn't have path, use custom drive root
  // For regular folders, we'll need to build the path by traversing up
  if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
    // Try to build path by traversing parent chain
    const folderPath = await buildFolderPath(parentId, userId);
    return folderPath || CUSTOM_DRIVE_PATH;
  }

  return null;
}

/**
 * Builds the folder path by traversing the parent chain
 */
async function buildFolderPath(folderId, userId) {
  if (!CUSTOM_DRIVE_ENABLED || !CUSTOM_DRIVE_PATH) {
    return null;
  }

  const pathParts = [];
  let currentId = folderId;

  // Traverse up the parent chain to build the path
  while (currentId) {
    const result = await pool.query(
      'SELECT name, parent_id, path FROM files WHERE id = $1 AND user_id = $2',
      [currentId, userId]
    );

    if (result.rows.length === 0) break;

    const folder = result.rows[0];
    
    // If we hit a custom drive folder (has absolute path), use it as base
    if (folder.path && path.isAbsolute(folder.path)) {
      return folder.path;
    }

    pathParts.unshift(folder.name);
    currentId = folder.parent_id;

    // Safety check to avoid infinite loops
    if (pathParts.length > 100) break;
  }

  // Build path from custom drive root
  if (pathParts.length > 0) {
    return path.join(CUSTOM_DRIVE_PATH, ...pathParts);
  }

  return CUSTOM_DRIVE_PATH;
}

/**
 * Generates a unique filename if the file already exists
 */
async function getUniqueFilename(filePath, folderPath) {
  const dir = path.dirname(filePath);
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  
  let finalPath = filePath;
  let counter = 1;

  while (await fs.promises.access(finalPath).then(() => true).catch(() => false)) {
    const newName = `${baseName} (${counter})${ext}`;
    finalPath = path.join(dir, newName);
    counter++;
    
    // Safety limit
    if (counter > 10000) {
      throw new Error('Too many duplicate files');
    }
  }

  return finalPath;
}

async function createFile(name, size, mimeType, tempPath, parentId = null, userId) {
  const id = generateId(16);
  
  // If custom drive is enabled, save to custom drive with original name
  if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
    try {
      // Get the target folder path
      const folderPath = await getFolderPath(parentId, userId);
      
      // Ensure the folder exists
      try {
        await fs.promises.access(folderPath || CUSTOM_DRIVE_PATH);
      } catch {
        // Folder doesn't exist, create it
        await fs.promises.mkdir(folderPath || CUSTOM_DRIVE_PATH, { recursive: true });
      }

      // Build the destination path with original filename
      const destPath = folderPath 
        ? path.join(folderPath, name)
        : path.join(CUSTOM_DRIVE_PATH, name);

      // Handle duplicate filenames
      const finalPath = await getUniqueFilename(destPath, folderPath || CUSTOM_DRIVE_PATH);
      
      // Move file to custom drive
      await fs.promises.rename(tempPath, finalPath);
      
      // Get the actual filename (in case it was changed due to duplicates)
      const actualName = path.basename(finalPath);
      
      // Store absolute path in database
      const absolutePath = path.resolve(finalPath);
      const result = await pool.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
        [id, actualName, 'file', size, mimeType, absolutePath, parentId, userId]
      );
      return result.rows[0];
    } catch (error) {
      // If custom drive save fails, fall back to regular upload
      console.error('[File] Error saving to custom drive, falling back to UPLOAD_DIR:', error);
      // Continue to regular upload logic below
    }
  }

  // Regular upload behavior (when custom drive is disabled or save failed)
  const ext = path.extname(name);
  const storageName = id + ext;
  const dest = path.join(UPLOAD_DIR, storageName);
  await fs.promises.rename(tempPath, dest);
  const result = await pool.query(
    'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [id, name, 'file', size, mimeType, storageName, parentId, userId]
  );
  return result.rows[0];
}

async function moveFiles(ids, parentId = null, userId) {
  await pool.query(
    'UPDATE files SET parent_id = $1, modified = NOW() WHERE id = ANY($2::text[]) AND user_id = $3',
    [parentId, ids, userId],
  );
}

async function copyEntry(id, parentId, userId, client = null) {
  const dbClient = client || pool;
  const res = await dbClient.query('SELECT * FROM files WHERE id = $1 AND user_id = $2', [id, userId]);
  if (res.rows.length === 0) return null;
  const file = res.rows[0];
  const newId = generateId(16);
  let storageName = null;
  let newPath = null;
  
  if (file.type === 'file') {
    // Get source file path (handles both relative and absolute)
    const sourcePath = resolveFilePath(file.path);
    
    if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
      // If custom drive is enabled, copy to custom drive with original name
      try {
        const folderPath = await getFolderPath(parentId, userId);
        const destDir = folderPath || CUSTOM_DRIVE_PATH;
        
        // Ensure destination directory exists
        try {
          await fs.promises.access(destDir);
        } catch {
          await fs.promises.mkdir(destDir, { recursive: true });
        }
        
        // Handle duplicate filenames
        let destPath = path.join(destDir, file.name);
        let counter = 1;
        while (await fs.promises.access(destPath).then(() => true).catch(() => false)) {
          const ext = path.extname(file.name);
          const baseName = path.basename(file.name, ext);
          const newName = `${baseName} (${counter})${ext}`;
          destPath = path.join(destDir, newName);
          counter++;
          if (counter > 10000) {
            throw new Error('Too many duplicate files');
          }
        }
        
        await fs.promises.copyFile(sourcePath, destPath);
        newPath = path.resolve(destPath);
        
        // Get the actual filename (in case it was changed due to duplicates)
        const actualName = path.basename(destPath);
        
        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            actualName,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ],
        );
      } catch (error) {
        // Fall back to regular copy if custom drive copy fails
        console.error('[File] Error copying to custom drive, falling back to UPLOAD_DIR:', error);
        const ext = path.extname(file.name);
        storageName = newId + ext;
        await fs.promises.copyFile(sourcePath, path.join(UPLOAD_DIR, storageName));
        newPath = storageName;
        
        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            file.name,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ],
        );
      }
    } else {
      // Regular copy to UPLOAD_DIR
      const ext = path.extname(file.name);
      storageName = newId + ext;
      try {
        await fs.promises.copyFile(sourcePath, path.join(UPLOAD_DIR, storageName));
      } catch (error) {
        console.error('Failed to copy file:', error);
        throw new Error('File copy operation failed');
      }
      newPath = storageName;
      
      await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          newId,
          file.name,
          file.type,
          file.size,
          file.mime_type,
          newPath,
          parentId,
          userId,
          file.starred,
          file.shared,
        ],
      );
    }
  } else if (file.type === 'folder') {
    // For folders created in custom drive, we need to create them on disk
    if (CUSTOM_DRIVE_ENABLED && CUSTOM_DRIVE_PATH) {
      try {
        const parentPath = await getFolderPath(parentId, userId);
        const folderPath = parentPath
          ? path.join(parentPath, file.name)
          : path.join(CUSTOM_DRIVE_PATH, file.name);
        
        // Handle duplicate folder names
        let finalPath = folderPath;
        let counter = 1;
        while (await fs.promises.access(finalPath).then(() => true).catch(() => false)) {
          const newName = `${file.name} (${counter})`;
          finalPath = parentPath
            ? path.join(parentPath, newName)
            : path.join(CUSTOM_DRIVE_PATH, newName);
          counter++;
          if (counter > 10000) {
            throw new Error('Too many duplicate folders');
          }
        }
        
        await fs.promises.mkdir(finalPath, { recursive: true });
        const actualName = path.basename(finalPath);
        newPath = path.resolve(finalPath);
        
        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            actualName,
            file.type,
            file.size,
            file.mime_type,
            newPath,
            parentId,
            userId,
            file.starred,
            file.shared,
          ],
        );
      } catch (error) {
        // Fall back to regular folder (no path)
        console.error('[File] Error creating folder in custom drive:', error);
        await dbClient.query(
          'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [
            newId,
            file.name,
            file.type,
            file.size,
            file.mime_type,
            null,
            parentId,
            userId,
            file.starred,
            file.shared,
          ],
        );
      }
    } else {
      // Regular folder (no path stored)
      await dbClient.query(
        'INSERT INTO files(id, name, type, size, mime_type, path, parent_id, user_id, starred, shared) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          newId,
          file.name,
          file.type,
          file.size,
          file.mime_type,
          null,
          parentId,
          userId,
          file.starred,
          file.shared,
        ],
      );
    }
    
    // Recursively copy folder contents
    const children = await dbClient.query('SELECT id FROM files WHERE parent_id = $1 AND user_id = $2', [id, userId]);
    for (const child of children.rows) {
      await copyEntry(child.id, newId, userId, client);
    }
  }
  return newId;
}

async function copyFiles(ids, parentId = null, userId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of ids) {
      await copyEntry(id, parentId, userId, client);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getFile(id, userId) {
  const result = await pool.query(
    'SELECT id, name, type, mime_type AS "mimeType", path FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [id, userId]
  );
  return result.rows[0];
}

async function renameFile(id, name, userId) {
  const result = await pool.query(
    'UPDATE files SET name = $1, modified = NOW() WHERE id = $2 AND user_id = $3 RETURNING id, name, type, size, modified, mime_type AS "mimeType", starred, shared',
    [name, id, userId],
  );
  return result.rows[0];
}

async function setStarred(ids, starred, userId) {
  await pool.query(
    'UPDATE files SET starred = $1 WHERE id = ANY($2::text[]) AND user_id = $3',
    [starred, ids, userId],
  );
}

async function getRecursiveIds(ids, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id FROM files WHERE id = ANY($1::text[]) AND user_id = $2
       UNION ALL
       SELECT f.id FROM files f JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2
     )
     SELECT id FROM sub`,
    [ids, userId],
  );
  return res.rows.map(r => r.id);
}

async function getFolderTree(folderId, userId) {
  const res = await pool.query(
    `WITH RECURSIVE sub AS (
       SELECT id, name, type, path, parent_id FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, f.name, f.type, f.path, f.parent_id FROM files f
       JOIN sub s ON f.parent_id = s.id
       WHERE f.user_id = $2 AND f.deleted_at IS NULL
     )
     SELECT id, name, type, path, parent_id FROM sub`,
    [folderId, userId],
  );
  return res.rows;
}

async function setShared(ids, shared, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return [];
  const res = await pool.query(
    'UPDATE files SET shared = $1 WHERE id = ANY($2::text[]) AND user_id = $3 RETURNING id',
    [shared, allIds, userId],
  );
  return res.rows.map(r => r.id);
}

async function deleteFiles(ids, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  await pool.query(
    'UPDATE files SET deleted_at = NOW() WHERE id = ANY($1::text[]) AND user_id = $2 AND deleted_at IS NULL',
    [allIds, userId],
  );
}

async function getTrashFiles(userId, sortBy = 'deletedAt', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const res = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared, deleted_at AS "deletedAt" FROM files WHERE user_id = $1 AND deleted_at IS NOT NULL ${orderClause}`,
    [userId],
  );
  const files = res.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

async function permanentlyDeleteFiles(ids, userId) {
  const allIds = await getRecursiveIds(ids, userId);
  if (allIds.length === 0) return;
  const files = await pool.query(
    'SELECT id, path, type FROM files WHERE id = ANY($1::text[]) AND user_id = $2',
    [allIds, userId],
  );
  
  // Delete files first, then folders
  const foldersToDelete = [];
  
  for (const f of files.rows) {
    if (!f.path) continue;
    
    try {
      if (f.type === 'file') {
        // Resolve file path (handles both relative and absolute paths)
        const filePath = resolveFilePath(f.path);
        await fs.promises.unlink(filePath);
      } else if (f.type === 'folder') {
        // For folders, we'll delete them after files are deleted
        // Only delete custom drive folders (those with absolute paths)
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      // Log error but continue with other deletions
      console.error(`[File] Error deleting ${f.type} ${f.path}:`, error.message);
    }
  }
  
  // Delete folders (in reverse order to handle nested folders)
  // Sort by path length descending so deeper folders are deleted first
  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      // Check if folder is empty before deleting
      const contents = await fs.promises.readdir(folderPath);
      if (contents.length === 0) {
        await fs.promises.rmdir(folderPath);
      }
    } catch (error) {
      // Folder might not be empty or already deleted, skip
      console.error(`[File] Error deleting folder ${folderPath}:`, error.message);
    }
  }
  
  await pool.query('DELETE FROM files WHERE id = ANY($1::text[]) AND user_id = $2', [allIds, userId]);
}

async function cleanupExpiredTrash() {
  const expired = await pool.query(
    "SELECT id, path, type FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'",
  );
  
  const foldersToDelete = [];
  
  for (const f of expired.rows) {
    if (!f.path) continue;
    
    try {
      if (f.type === 'file') {
        // Resolve file path (handles both relative and absolute paths)
        const filePath = resolveFilePath(f.path);
        await fs.promises.unlink(filePath);
      } else if (f.type === 'folder') {
        // For folders, collect them for deletion after files
        if (path.isAbsolute(f.path)) {
          foldersToDelete.push(f.path);
        }
      }
    } catch (error) {
      // Log error but continue
      console.error(`[Trash] Error cleaning up ${f.type} ${f.path}:`, error.message);
    }
  }
  
  // Delete folders (in reverse order)
  foldersToDelete.sort((a, b) => b.length - a.length);
  for (const folderPath of foldersToDelete) {
    try {
      const contents = await fs.promises.readdir(folderPath);
      if (contents.length === 0) {
        await fs.promises.rmdir(folderPath);
      }
    } catch (error) {
      console.error(`[Trash] Error deleting folder ${folderPath}:`, error.message);
    }
  }
  
  await pool.query(
    "DELETE FROM files WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL '15 days'",
  );
}

async function cleanupOrphanFiles() {
  const uploadsDir = UPLOAD_DIR;
  let diskFiles = [];
  try {
    diskFiles = await fs.promises.readdir(uploadsDir);
  } catch {
    diskFiles = [];
  }
  const diskSet = new Set(diskFiles);

  // Only check files in UPLOAD_DIR, not custom drive files (which have absolute paths)
  const dbRes = await pool.query(
    "SELECT id, path FROM files WHERE type = 'file' AND path IS NOT NULL"
  );
  const dbSet = new Set();
  for (const row of dbRes.rows) {
    if (!row.path) continue;

    // Skip custom drive files (they have absolute paths, not relative to UPLOAD_DIR)
    if (path.isAbsolute(row.path)) {
      continue;
    }

    dbSet.add(row.path);
    // Only delete if it's a regular upload file (relative path) that doesn't exist on disk
    if (!diskSet.has(row.path)) {
      await pool.query('DELETE FROM files WHERE id = $1', [row.id]);
    }
  }

  // Clean up files on disk that aren't in database
  for (const file of diskFiles) {
    if (!dbSet.has(file)) {
      try {
        await fs.promises.unlink(path.join(uploadsDir, file));
      } catch {}
    }
  }
}

async function getStarredFiles(userId, sortBy = 'modified', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE user_id = $1 AND starred = TRUE ${orderClause}`,
    [userId],
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

async function getSharedFiles(userId, sortBy = 'modified', order = 'DESC') {
  const orderClause = sortBy === 'size' ? '' : buildOrderClause(sortBy, order);
  const result = await pool.query(
    `SELECT id, name, type, size, modified, mime_type AS "mimeType", starred, shared FROM files WHERE user_id = $1 AND shared = TRUE ${orderClause}`,
    [userId],
  );
  const files = result.rows;
  if (sortBy === 'size') {
    await fillFolderSizes(files, userId);
    files.sort((a, b) => {
      const diff = (a.size || 0) - (b.size || 0);
      return order && order.toUpperCase() === 'ASC' ? diff : -diff;
    });
  }
  return files;
}

/**
 * Search files and folders using optimized trigram similarity
 * This uses PostgreSQL's pg_trgm extension for fast fuzzy text matching
 * Optimized for performance with smart query patterns based on query length
 * @param {string} userId - User ID to search files for
 * @param {string} query - Search query string
 * @param {number} limit - Maximum number of results (default: 100)
 * @returns {Promise<Array>} Array of matching files
 */
async function searchFiles(userId, query, limit = 100) {
  if (!query || query.trim().length === 0) {
    return [];
  }

  const searchTerm = query.trim();
  const searchLength = searchTerm.length;
  
  // For very short queries (1-2 chars), use prefix matching only for better performance
  // For longer queries, use trigram similarity for fuzzy matching
  // Use optimized query patterns to leverage GIN indexes effectively
  let sqlQuery;
  let queryParams;

  if (searchLength <= 2) {
    // Short queries: Use prefix matching (index-friendly)
    // This avoids expensive trigram calculations for very short queries
    sqlQuery = `
      SELECT 
        id, 
        name, 
        type, 
        size, 
        modified, 
        mime_type AS "mimeType", 
        starred, 
        shared,
        parent_id AS "parentId"
      FROM files 
      WHERE user_id = $1 
        AND deleted_at IS NULL
        AND lower(name) LIKE lower($2) || '%'
      ORDER BY 
        CASE
          WHEN lower(name) = lower($2) THEN 1
          ELSE 2
        END ASC,
        name ASC,
        modified DESC
      LIMIT $3
    `;
    queryParams = [userId, searchTerm, limit];
  } else {
    // Longer queries: Use trigram similarity for fuzzy matching
    // Optimized to use index scans where possible
    sqlQuery = `
      SELECT 
        id, 
        name, 
        type, 
        size, 
        modified, 
        mime_type AS "mimeType", 
        starred, 
        shared,
        parent_id AS "parentId"
      FROM files 
      WHERE user_id = $1 
        AND deleted_at IS NULL
        AND (
          -- Prefix match (fast with index)
          lower(name) LIKE lower($2) || '%'
          OR 
          -- Full text match (uses trigram index)
          (lower(name) LIKE '%' || lower($2) || '%' AND similarity(lower(name), lower($2)) > 0.15)
        )
      ORDER BY 
        CASE
          WHEN lower(name) = lower($2) THEN 1
          WHEN lower(name) LIKE lower($2) || '%' THEN 2
          ELSE 3
        END ASC,
        similarity(lower(name), lower($2)) DESC NULLS LAST,
        modified DESC
      LIMIT $3
    `;
    queryParams = [userId, searchTerm, limit];
  }

  const result = await pool.query(sqlQuery, queryParams);
  const files = result.rows;

  // Fill folder sizes for folders (only if needed, in batches)
  await fillFolderSizes(files, userId);

  return files;
}

/**
 * Get file statistics for a user
 * Returns total counts of files, folders, shared items, and starred items
 * @param {string} userId - User ID to get stats for
 * @returns {Promise<Object>} Object with totalFiles, totalFolders, sharedCount, starredCount
 */
async function getFileStats(userId) {
  const result = await pool.query(
    `SELECT 
      COUNT(*) FILTER (WHERE type = 'file' AND deleted_at IS NULL) AS "totalFiles",
      COUNT(*) FILTER (WHERE type = 'folder' AND deleted_at IS NULL) AS "totalFolders",
      COUNT(*) FILTER (WHERE shared = TRUE AND deleted_at IS NULL) AS "sharedCount",
      COUNT(*) FILTER (WHERE starred = TRUE AND deleted_at IS NULL) AS "starredCount"
     FROM files
     WHERE user_id = $1`,
    [userId]
  );
  
  return {
    totalFiles: parseInt(result.rows[0].totalFiles, 10) || 0,
    totalFolders: parseInt(result.rows[0].totalFolders, 10) || 0,
    sharedCount: parseInt(result.rows[0].sharedCount, 10) || 0,
    starredCount: parseInt(result.rows[0].starredCount, 10) || 0,
  };
}

module.exports = {
  getFiles,
  createFolder,
  createFile,
  moveFiles,
  copyFiles,
  getFile,
  renameFile,
  setStarred,
  getStarredFiles,
  setShared,
  getRecursiveIds,
  getFolderTree,
  getSharedFiles,
  deleteFiles,
  getTrashFiles,
  permanentlyDeleteFiles,
  cleanupExpiredTrash,
  cleanupOrphanFiles,
  searchFiles,
  getFileStats,
};
