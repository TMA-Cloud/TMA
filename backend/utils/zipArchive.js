import path from 'path';

import archiver from 'archiver';

import { logger } from '../config/logger.js';
import { isFilePathEncrypted, isValidPath, resolveFilePath } from './filePath.js';
import { createDecryptStream, createDecryptStreamFromStream } from './fileEncryption.js';
import { contentDispositionValue } from './fileDownload.js';
import storage from './storageDriver.js';

function setZipHeaders(res, archiveName) {
  res.setHeader('Content-Type', 'application/zip');
  const zipFilename = `${archiveName}.zip`;
  res.setHeader('Content-Disposition', contentDispositionValue('attachment', zipFilename));
}

function attachArchiveHandlers(archive, res, onSuccess) {
  let archiveAborted = false;
  let archiveError = null;

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

  return {
    markAborted: err => {
      archiveAborted = true;
      archiveError = err;
    },
    isAborted: () => archiveAborted,
    getError: () => archiveError,
  };
}

async function addFileToArchive(archive, entry, nameInArchive) {
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
    return;
  }

  const p = resolveFilePath(entry.path);
  if (isEncrypted) {
    const { stream } = await createDecryptStream(p);
    archive.append(stream, { name: nameInArchive });
  } else {
    archive.file(p, { name: nameInArchive });
  }
}

async function appendEntryTree(archive, allEntries, parentId, base) {
  const entriesToProcess = allEntries.filter(e => e.parent_id === parentId);
  for (const entry of entriesToProcess) {
    const relPath = base ? path.join(base, entry.name) : entry.name;
    if (entry.type === 'file' && isValidPath(entry.path)) {
      try {
        await addFileToArchive(archive, entry, relPath);
      } catch (err) {
        logger.error(`[ZIP] Error adding file to archive: ${entry.name}`, err);
        throw err;
      }
    } else if (entry.type === 'folder') {
      await appendEntryTree(archive, allEntries, entry.id, relPath);
    }
  }
}

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
  setZipHeaders(res, archiveName);

  const archive = archiver('zip');
  const state = attachArchiveHandlers(archive, res, onSuccess);

  archive.pipe(res);

  try {
    await appendEntryTree(archive, entries, rootId, baseName);
    archive.finalize();
  } catch (err) {
    logger.error('[ZIP] Error building archive:', err);
    state.markAborted(err);
    archive.abort();

    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    } else {
      logger.error('[ZIP] Error after headers sent - cannot send error response');
    }
    throw err;
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
  setZipHeaders(res, archiveName);

  const archive = archiver('zip');
  const state = attachArchiveHandlers(archive, res, onSuccess);

  archive.pipe(res);

  try {
    for (const rootId of rootIds) {
      const rootEntry = allEntries.find(e => e.id === rootId);
      if (!rootEntry) continue;

      if (rootEntry.type === 'file' && isValidPath(rootEntry.path)) {
        try {
          await addFileToArchive(archive, rootEntry, rootEntry.name);
        } catch (err) {
          logger.error(`[ZIP] Error adding root file to archive: ${rootEntry.name}`, err);
          throw err;
        }
      } else if (rootEntry.type === 'folder') {
        await appendEntryTree(archive, allEntries, rootId, rootEntry.name);
      }
    }

    archive.finalize();
  } catch (err) {
    logger.error('[ZIP] Error building bulk archive:', err);
    state.markAborted(err);
    archive.abort();

    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create archive' });
    } else {
      logger.error('[ZIP] Error after headers sent - cannot send error response');
    }
    throw err;
  }
}

export { createZipArchive, createBulkZipArchive };
