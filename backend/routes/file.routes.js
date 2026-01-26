const express = require('express');
const {
  listFiles,
  addFolder,
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
const { apiRateLimiter, uploadRateLimiter, sseConnectionLimiter } = require('../middleware/rateLimit.middleware');
const { attachCustomDrivePath } = require('../middleware/customDrive.middleware');
const { checkStorageLimit } = require('../middleware/storageLimit.middleware');
const router = express.Router();

router.use(auth);
router.use(apiRateLimiter);

// SSE endpoint with dedicated connection limiting
router.get('/events', sseConnectionLimiter, streamFileEvents);
router.get('/', listFiles);
router.get('/stats', getFileStats);
router.get('/search', searchFiles);
router.post('/folder', addFolder);
router.post('/upload', uploadRateLimiter, attachCustomDrivePath, checkStorageLimit, upload.single('file'), uploadFile);
router.post(
  '/upload/bulk',
  uploadRateLimiter,
  attachCustomDrivePath,
  checkStorageLimit,
  upload.array('files'),
  uploadFilesBulk
);
router.post('/move', moveFiles);
router.post('/copy', copyFiles);
router.post('/rename', renameFile);
router.post('/star', starFiles);
router.get('/starred', listStarred);
router.post('/share', shareFiles);
router.post('/share/links', getShareLinks);
router.get('/shared', listShared);
router.post('/link-parent-share', linkParentShare);
router.post('/delete', deleteFiles);
router.get('/trash', listTrash);
router.post('/trash/restore', restoreFiles);
router.post('/trash/delete', deleteForever);
router.post('/trash/empty', emptyTrash);
router.post('/download/bulk', downloadFilesBulk);
router.get('/:id/download', downloadFile);

module.exports = router;
