/*
 * file-utils barrel: re-exports the per-concern modules under ./file-utils/
 * (http, download, upload, names, tempdirs, clipboard, hash) under the same
 * names and import path they've always had, so no consumer moves.
 */
const { getCookieHeader, getJson, apiPostJson, makeIpcProgressEmitter } = require('./file-utils/http.cjs');
const {
  downloadToFile,
  downloadPostToFile,
  getFileInfoFromBackend,
  listFilesFromBackend,
} = require('./file-utils/download.cjs');
const { uploadFileToReplace, uploadDerivedFile, uploadNewFile } = require('./file-utils/upload.cjs');
const { validateOrigin, sanitizeFileName, deduplicateFileName } = require('./file-utils/names.cjs');
const {
  PASTE_DIR_PREFIX,
  EDIT_DIR_PREFIX,
  createTempDir,
  cleanTempDirsByPrefix,
  cleanTempClipboardDirs,
  cleanTempEditDirs,
} = require('./file-utils/tempdirs.cjs');
const { setClipboardToPaths } = require('./file-utils/clipboard.cjs');
const { hashFile } = require('./file-utils/hash.cjs');

module.exports = {
  PASTE_DIR_PREFIX,
  EDIT_DIR_PREFIX,
  sanitizeFileName,
  deduplicateFileName,
  createTempDir,
  downloadToFile,
  downloadPostToFile,
  getFileInfoFromBackend,
  setClipboardToPaths,
  cleanTempDirsByPrefix,
  cleanTempClipboardDirs,
  cleanTempEditDirs,
  uploadFileToReplace,
  uploadDerivedFile,
  hashFile,
  validateOrigin,
  getJson,
  apiPostJson,
  makeIpcProgressEmitter,
  listFilesFromBackend,
  uploadNewFile,
  getCookieHeader,
};
