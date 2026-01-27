const express = require('express');
const { handleShared, downloadFolderZip, downloadSharedItem } = require('../controllers/share.controller');
const { apiRateLimiter } = require('../middleware/rateLimit.middleware');
const router = express.Router();
const { validate } = require('../middleware/validation.middleware');
const { handleSharedSchema, downloadFolderZipSchema, downloadSharedItemSchema } = require('../utils/validationSchemas');

router.use(apiRateLimiter);

router.get('/:token/file/:id', downloadSharedItemSchema, validate, downloadSharedItem);
router.get('/:token/zip', downloadFolderZipSchema, validate, downloadFolderZip);
router.get('/:token', handleSharedSchema, validate, handleShared);

module.exports = router;
