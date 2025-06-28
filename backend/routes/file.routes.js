const express = require('express');
const multer = require('multer');
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
} = require('../controllers/file.controller');
const auth = require('../middleware/auth.middleware');
const router = express.Router();

const upload = multer({ dest: 'uploads/' });

router.use(auth);

router.get('/', listFiles);
router.post('/folder', addFolder);
router.post('/upload', upload.single('file'), uploadFile);
router.post('/move', moveFiles);
router.post('/copy', copyFiles);
router.post('/rename', renameFile);
router.post('/star', starFiles);
router.get('/starred', listStarred);
router.post('/share', shareFiles);
router.get('/shared', listShared);
router.get('/:id/download', downloadFile);

module.exports = router;
