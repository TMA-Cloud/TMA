/**
 * File CRUD Controller Index
 *
 * This file re-exports the file CRUD handlers, split into focused modules by
 * HTTP concern for maintainability. Import paths and exported names are kept
 * identical so consumers (routes, the controllers/file.controller.js barrel)
 * do not move:
 * - file.upload.controller.js   - upload, replace, derived, bulk upload + storage check
 * - file.download.controller.js - single and bulk download
 * - file.listing.controller.js  - list, create folder, rename
 */

export {
  checkUploadStorage,
  uploadFile,
  uploadFilesBulk,
  replaceFileContents,
  uploadDerivedFile,
} from './file.upload.controller.js';
export { downloadFile, downloadFilesBulk } from './file.download.controller.js';
export { listFiles, addFolder, renameFile } from './file.listing.controller.js';
