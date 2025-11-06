const express = require('express');
const {
  listFiles,
  addFolder,
  uploadFile,
  moveFiles,
  copyFiles,
  downloadFile,
  renameFile,
  starFiles,
  listStarred,
  shareFiles,
  listShared,
  linkParentShare,
  deleteFiles,
  listTrash,
  deleteForever,
  searchFiles,
  getFileStats,
} = require('../controllers/file.controller');
const auth = require('../middleware/auth.middleware');
const upload = require('../utils/multer');
const router = express.Router();

router.use(auth);

router.get('/', listFiles);
router.get('/stats', getFileStats);
router.get('/search', searchFiles);
router.post('/folder', addFolder);
router.post('/upload', upload.single('file'), uploadFile);
router.post('/move', moveFiles);
router.post('/copy', copyFiles);
router.post('/rename', renameFile);
router.post('/star', starFiles);
router.get('/starred', listStarred);
router.post('/share', shareFiles);
router.get('/shared', listShared);
router.post('/link-parent-share', linkParentShare);
router.post('/delete', deleteFiles);
router.get('/trash', listTrash);
router.post('/trash/delete', deleteForever);
router.get('/:id/download', downloadFile);

module.exports = router;
