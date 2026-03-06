import express from 'express';

import {
  addFolder,
  checkUploadStorage,
  copyFiles,
  deleteFiles,
  deleteForever,
  downloadFile,
  downloadFilesBulk,
  emptyTrash,
  getFileInfo,
  getFileStats,
  getShareLinks,
  linkParentShare,
  listFiles,
  listShared,
  listStarred,
  listTrash,
  moveFiles,
  renameFile,
  replaceFileContents,
  restoreFiles,
  searchFiles,
  shareFiles,
  starFiles,
  uploadDerivedFile,
  uploadFile,
  uploadFilesBulk,
} from '../controllers/file.controller.js';
import { streamFileEvents } from '../controllers/file/file.events.controller.js';
import auth from '../middleware/auth.middleware.js';
import { streamUploadToS3 } from '../middleware/streamUploadToS3.middleware.js';
import { apiRateLimiter, sseConnectionLimiter, uploadRateLimiter } from '../middleware/rateLimit.middleware.js';
import { checkStorageLimit } from '../middleware/storageLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { uploadArrayWithDynamicLimit, uploadSingleWithDynamicLimit } from '../utils/multer.js';
import storage from '../utils/storageDriver.js';

/** When S3: stream directly to bucket (no temp dir). Otherwise use multer disk with admin-configurable max file size. */
function uploadSingle() {
  return storage.useS3() ? streamUploadToS3('single') : uploadSingleWithDynamicLimit();
}
function uploadBulk() {
  return storage.useS3() ? streamUploadToS3('bulk') : uploadArrayWithDynamicLimit();
}
import {
  addFolderSchema,
  checkUploadStorageSchema,
  copyFilesSchema,
  deleteFilesSchema,
  deleteForeverSchema,
  downloadFileSchema,
  downloadFilesBulkSchema,
  getShareLinksSchema,
  linkParentShareSchema,
  moveFilesSchema,
  renameFileSchema,
  restoreFilesSchema,
  shareFilesSchema,
  starFilesSchema,
} from '../utils/validationSchemas.js';

const router = express.Router();

router.use(auth);
router.use(apiRateLimiter);

// SSE endpoint with dedicated connection limiting
router.get('/events', sseConnectionLimiter, streamFileEvents);
router.get('/', listFiles);
router.get('/stats', getFileStats);
router.get('/:id/info', getFileInfo);
router.get('/search', searchFiles);
router.post('/folder', addFolderSchema, validate, addFolder);
router.post('/upload/check', uploadRateLimiter, checkUploadStorageSchema, validate, checkUploadStorage);
router.post('/upload', uploadRateLimiter, checkStorageLimit, uploadSingle(), uploadFile);
router.post('/upload/bulk', uploadRateLimiter, checkStorageLimit, uploadBulk(), uploadFilesBulk);
router.post('/move', moveFilesSchema, validate, moveFiles);
router.post('/copy', copyFilesSchema, validate, copyFiles);
router.post('/rename', renameFileSchema, validate, renameFile);
router.post('/star', starFilesSchema, validate, starFiles);
router.get('/starred', listStarred);
router.post('/share', shareFilesSchema, validate, shareFiles);
router.post('/share/links', getShareLinksSchema, validate, getShareLinks);
router.get('/shared', listShared);
router.post('/link-parent-share', linkParentShareSchema, validate, linkParentShare);
router.post('/delete', deleteFilesSchema, validate, deleteFiles);
router.get('/trash', listTrash);
router.post('/trash/restore', restoreFilesSchema, validate, restoreFiles);
router.post('/trash/delete', deleteForeverSchema, validate, deleteForever);
router.post('/trash/empty', emptyTrash);
router.post('/download/bulk', downloadFilesBulkSchema, validate, downloadFilesBulk);
router.get('/:id/download', downloadFileSchema, validate, downloadFile);
router.post('/:id/replace', uploadRateLimiter, uploadSingleWithDynamicLimit(), replaceFileContents);
// Upload a new file derived from an existing one (e.g. "Save as PDF" from desktop editor)
// When S3 is enabled this uses streamUploadToS3, otherwise multer disk upload.
router.post('/:id/derived', uploadRateLimiter, uploadSingle(), uploadDerivedFile);

export default router;
