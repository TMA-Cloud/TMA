const path = require('path');
const archiver = require('archiver');
const { resolveFilePath, isValidPath, isFilePathEncrypted } = require('./filePath');
const { createDecryptStream } = require('./fileEncryption');
const { logger } = require('../config/logger');
const { agentReadFileStream } = require('./agentFileOperations');
const { isAgentOfflineError } = require('./agentErrorDetection');

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
            const p = resolveFilePath(entry.path);
            const isEncrypted = isFilePathEncrypted(entry.path);
            const isCustomDrive = path.isAbsolute(entry.path);

            if (isEncrypted) {
              // For encrypted files, use decrypt stream
              const { stream } = await createDecryptStream(p);
              archive.append(stream, { name: relPath });
            } else if (isCustomDrive) {
              // For custom drive files, stream via agent API (memory efficient for large files)
              const stream = agentReadFileStream(p);
              archive.append(stream, { name: relPath });
            } else {
              // For regular unencrypted files, add directly
              archive.file(p, { name: relPath });
            }
          } catch (err) {
            logger.error(`[ZIP] Error adding file to archive: ${entry.name}`, err);
            // Re-throw agent connection errors so they can be caught upstream
            if (isAgentOfflineError(err)) {
              archiveAborted = true;
              archiveError = err;
              throw err;
            }
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
      // Check if it's an agent error
      if (isAgentOfflineError(err)) {
        const { AGENT_OFFLINE_MESSAGE, AGENT_OFFLINE_STATUS } = require('./agentConstants');
        res.status(AGENT_OFFLINE_STATUS).json({ error: AGENT_OFFLINE_MESSAGE });
      } else {
        res.status(500).json({ error: 'Failed to create archive' });
      }
    } else {
      // Headers already sent - can't send error response, just log
      logger.error('[ZIP] Error after headers sent - cannot send error response');
    }
    throw err; // Re-throw so upstream can handle it
  }
}

module.exports = { createZipArchive };
