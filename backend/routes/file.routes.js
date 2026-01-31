const express = require('express');
const {
  listFiles,
  addFolder,
  checkUploadStorage,
  uploadFile,
  uploadFilesBulk,
  moveFiles,
  copyFiles,
  downloadFile,
  downloadFilesBulk,
  renameFile,
  starFiles,
  listStarred,
  shareFiles,
  getShareLinks,
  listShared,
  linkParentShare,
  deleteFiles,
  listTrash,
  restoreFiles,
  deleteForever,
  emptyTrash,
  searchFiles,
  getFileStats,
} = require('../controllers/file.controller');
const { streamFileEvents } = require('../controllers/file/file.events.controller');
const auth = require('../middleware/auth.middleware');
const upload = require('../utils/multer');
const { streamUploadToS3 } = require('../middleware/streamUploadToS3.middleware');
const storage = require('../utils/storageDriver');
const { apiRateLimiter, uploadRateLimiter, sseConnectionLimiter } = require('../middleware/rateLimit.middleware');
const { checkStorageLimit } = require('../middleware/storageLimit.middleware');

/** When S3: stream directly to bucket (no temp dir). Otherwise use multer disk. */
function uploadSingle() {
  return storage.useS3() ? streamUploadToS3('single') : upload.single('file');
}
function uploadBulk() {
  return storage.useS3() ? streamUploadToS3('bulk') : upload.array('files');
}
const router = express.Router();
const { validate } = require('../middleware/validation.middleware');
const {
  addFolderSchema,
  renameFileSchema,
  downloadFileSchema,
  downloadFilesBulkSchema,
  moveFilesSchema,
  copyFilesSchema,
  starFilesSchema,
  shareFilesSchema,
  getShareLinksSchema,
  linkParentShareSchema,
  deleteFilesSchema,
  restoreFilesSchema,
  deleteForeverSchema,
  checkUploadStorageSchema,
} = require('../utils/validationSchemas');

router.use(auth);
router.use(apiRateLimiter);

// SSE endpoint with dedicated connection limiting
router.get('/events', sseConnectionLimiter, streamFileEvents);
router.get('/', listFiles);
router.get('/stats', getFileStats);
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

module.exports = router;
