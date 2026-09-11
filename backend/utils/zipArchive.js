import { finished } from 'stream/promises';

import { ZipArchive } from 'archiver';

import { logger } from '../config/logger.js';
import { resolveIkmForPath } from '../models/file/file.dek.model.js';
import { isFilePathEncrypted, isValidPath } from './filePath.js';
import { createDecryptStreamFromStream } from './fileEncryption.js';
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

  const readStream = await storage.getReadStream(entry.path);
  let source;
  if (isEncrypted) {
    const ikm = await resolveIkmForPath(entry.path);
    const { stream } = await createDecryptStreamFromStream(readStream, ikm);
    source = stream;
  } else {
    source = readStream;
  }
  archive.append(source, { name: nameInArchive });
  await finished(source);
}

/** Build a ZIP from an async DB cursor without retaining the whole tree. */
async function createStreamingZipArchive(res, archiveName, entries, onEntry, onSuccess) {
  setZipHeaders(res, archiveName);
  const archive = new ZipArchive();
  const state = attachArchiveHandlers(archive, res, onSuccess);
  archive.pipe(res);
  try {
    for await (const entry of entries) {
      onEntry?.(entry);
      if (entry.type === 'file' && isValidPath(entry.path)) {
        await addFileToArchive(archive, entry, entry.archivePath);
      }
    }
    archive.finalize();
  } catch (err) {
    state.markAborted(err);
    archive.abort();
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create archive' });
    throw err;
  }
}

export { createStreamingZipArchive };
