const path = require('path');
const archiver = require('archiver');
const { resolveFilePath, isValidPath, isFilePathEncrypted } = require('./filePath');
const { createDecryptStream } = require('./fileEncryption');
const { logger } = require('../config/logger');

/**
 * Create a ZIP archive from a tree of entries and pipe it to a response
 * @param {Object} res - Express response object
 * @param {string} archiveName - Name of the ZIP file
 * @param {Array} entries - Array of file/folder entries with {id, parent_id, name, type, path}
 * @param {string} rootId - Root folder ID to start archiving from
 * @param {string} baseName - Base folder name to use in the archive
 */
function createZipArchive(res, archiveName, entries, rootId, baseName) {
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
  archive.pipe(res);

  (async () => {
    try {
      const addEntry = async (id, base) => {
        const entriesToProcess = entries.filter(e => e.parent_id === id);
        for (const entry of entriesToProcess) {
          const relPath = base ? path.join(base, entry.name) : entry.name;
          if (entry.type === 'file' && isValidPath(entry.path)) {
            try {
              const p = resolveFilePath(entry.path);
              const isEncrypted = isFilePathEncrypted(entry.path);

              if (isEncrypted) {
                // For encrypted files, use decrypt stream
                const { stream } = await createDecryptStream(p);
                archive.append(stream, { name: relPath });
              } else {
                // For unencrypted files (custom-drive), add directly
                archive.file(p, { name: relPath });
              }
            } catch (err) {
              logger.error(`[ZIP] Error adding file to archive: ${entry.name}`, err);
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
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to create archive' });
      }
      archive.abort();
    }
  })();
}

module.exports = { createZipArchive };
