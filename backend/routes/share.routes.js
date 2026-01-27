const express = require('express');
const { handleShared, downloadFolderZip, downloadSharedItem } = require('../controllers/share.controller');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');
const router = express.Router();

router.use(apiRateLimiter);

router.get('/:token/file/:id', downloadSharedItem);
router.get('/:token/zip', downloadFolderZip);
router.get('/:token', handleShared);

module.exports = router;
