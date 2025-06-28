const express = require('express');
const {
  handleShared,
  downloadFolderZip,
  downloadSharedItem,
} = require('../controllers/share.controller');
const router = express.Router();

router.get('/:token/file/:id', downloadSharedItem);
router.get('/:token/zip', downloadFolderZip);
router.get('/:token', handleShared);

module.exports = router;
