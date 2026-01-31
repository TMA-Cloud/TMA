const path = require('path');
const archiver = require('archiver');
const { resolveFilePath, isValidPath, isFilePathEncrypted } = require('./filePath');
const { createDecryptStream, createDecryptStreamFromStream } = require('./fileEncryption');
const { logger } = require('../config/logger');
const storage = require('./storageDriver');

/**
 * Create a ZIP archive from a tree of entries and pipe it to a response
 * @param {Object} res - Express response object
 * @param {string} archiveName - Name of the ZIP file
 * @param {Array} entries - Array of file/folder entries with {id, parent_id, name, type, path}
 * @param {string} rootId - Root folder ID to start archiving from
 * @param {string} baseName - Base folder name to use in the archive
 * @param {Function} onSuccess - Optional callback to call after successful archive creation
 */
async function createZipArchive(res, archiveName, entries, rootId, baseName, onSuccess) {
  res.setHeader('Content-Type', 'application/zip');
  // Use RFC 5987 encoding for filenames with special characters
  const zipFilename = `${archiveName}.zip`;
  const encodedFilename = encodeURIComponent(zipFilename);
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"; filename*=UTF-8''${encodedFilename}`);

  const archive = archiver('zip');
  archive.on('error', err => {
    logger.error('[ZIP] Archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    }
  });
  // Track if archive was aborted due to error
  let archiveAborted = false;
  let archiveError = null;

  // Set up success callback BEFORE piping to response
  // Only call onSuccess if archive completed successfully (not aborted)
  if (onSuccess) {
    archive.on('end', async () => {
      // Only call success callback if archive wasn't aborted due to error
      if (!archiveAborted && !archiveError) {
        try {
          await onSuccess();
        } catch (callbackError) {
          logger.error('[ZIP] Error in success callback:', callbackError);
        }
      }
    });
  }

  archive.on('error', err => {
    archiveError = err;
    archiveAborted = true;
    logger.error('[ZIP] Archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    }
  });

  archive.pipe(res);

  try {
    const addEntry = async (id, base) => {
      const entriesToProcess = entries.filter(e => e.parent_id === id);
      for (const entry of entriesToProcess) {
        const relPath = base ? path.join(base, entry.name) : entry.name;
        if (entry.type === 'file' && isValidPath(entry.path)) {
          try {
            const isEncrypted = isFilePathEncrypted(entry.path);
            if (storage.useS3()) {
              const readStream = await storage.getReadStream(entry.path);
              if (isEncrypted) {
                const { stream } = await createDecryptStreamFromStream(readStream);
                archive.append(stream, { name: relPath });
              } else {
                archive.append(readStream, { name: relPath });
              }
            } else {
              const p = resolveFilePath(entry.path);
              if (isEncrypted) {
                const { stream } = await createDecryptStream(p);
                archive.append(stream, { name: relPath });
              } else {
                archive.file(p, { name: relPath });
              }
            }
          } catch (err) {
            logger.error(`[ZIP] Error adding file to archive: ${entry.name}`, err);
            throw err;
          }
        } else if (entry.type === 'folder') {
          await addEntry(entry.id, relPath);
        }
      }
    };

    await addEntry(rootId, baseName);
    archive.finalize();
  } catch (err) {
    logger.error('[ZIP] Error building archive:', err);
    archiveAborted = true;
    archiveError = err;
    archive.abort();

    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    } else {
      // Headers already sent - can't send error response, just log
      logger.error('[ZIP] Error after headers sent - cannot send error response');
    }
    throw err; // Re-throw so upstream can handle it
  }
}

/**
 * Create a ZIP archive from multiple files/folders and pipe it to a response
 * @param {Object} res - Express response object
 * @param {string} archiveName - Name of the ZIP file
 * @param {Array} allEntries - Array of all file/folder entries with {id, parent_id, name, type, path}
 * @param {Array} rootIds - Array of root file/folder IDs to include in the archive
 * @param {Function} onSuccess - Optional callback to call after successful archive creation
 */
async function createBulkZipArchive(res, archiveName, allEntries, rootIds, onSuccess) {
  res.setHeader('Content-Type', 'application/zip');
  // Use RFC 5987 encoding for filenames with special characters
  const zipFilename = `${archiveName}.zip`;
  const encodedFilename = encodeURIComponent(zipFilename);
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"; filename*=UTF-8''${encodedFilename}`);

  const archive = archiver('zip');
  // Track if archive was aborted due to error
  let archiveAborted = false;
  let archiveError = null;

  // Set up success callback BEFORE piping to response
  if (onSuccess) {
    archive.on('end', async () => {
      if (!archiveAborted && !archiveError) {
        try {
          await onSuccess();
        } catch (callbackError) {
          logger.error('[ZIP] Error in success callback:', callbackError);
        }
      }
    });
  }

  archive.on('error', err => {
    archiveError = err;
    archiveAborted = true;
    logger.error('[ZIP] Archive error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    }
  });

  archive.pipe(res);

  try {
    const addFileToArchive = async (entry, nameInArchive) => {
      if (!isValidPath(entry.path)) return;
      const isEncrypted = isFilePathEncrypted(entry.path);
      if (storage.useS3()) {
        const readStream = await storage.getReadStream(entry.path);
        if (isEncrypted) {
          const { stream } = await createDecryptStreamFromStream(readStream);
          archive.append(stream, { name: nameInArchive });
        } else {
          archive.append(readStream, { name: nameInArchive });
        }
      } else {
        const p = resolveFilePath(entry.path);
        if (isEncrypted) {
          const { stream } = await createDecryptStream(p);
          archive.append(stream, { name: nameInArchive });
        } else {
          archive.file(p, { name: nameInArchive });
        }
      }
    };

    const addEntry = async (id, base) => {
      const entriesToProcess = allEntries.filter(e => e.parent_id === id);
      for (const entry of entriesToProcess) {
        const relPath = base ? path.join(base, entry.name) : entry.name;
        if (entry.type === 'file' && isValidPath(entry.path)) {
          try {
            await addFileToArchive(entry, relPath);
          } catch (err) {
            logger.error(`[ZIP] Error adding file to archive: ${entry.name}`, err);
            throw err;
          }
        } else if (entry.type === 'folder') {
          await addEntry(entry.id, relPath);
        }
      }
    };

    for (const rootId of rootIds) {
      const rootEntry = allEntries.find(e => e.id === rootId);
      if (!rootEntry) continue;

      if (rootEntry.type === 'file' && isValidPath(rootEntry.path)) {
        try {
          await addFileToArchive(rootEntry, rootEntry.name);
        } catch (err) {
          logger.error(`[ZIP] Error adding root file to archive: ${rootEntry.name}`, err);
          throw err;
        }
      } else if (rootEntry.type === 'folder') {
        await addEntry(rootId, rootEntry.name);
      }
    }

    archive.finalize();
  } catch (err) {
    logger.error('[ZIP] Error building bulk archive:', err);
    archiveAborted = true;
    archiveError = err;
    archive.abort();

    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    } else {
      logger.error('[ZIP] Error after headers sent - cannot send error response');
    }
    throw err;
  }
}

module.exports = { createZipArchive, createBulkZipArchive };
