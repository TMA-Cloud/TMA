import express from 'express';

import { downloadFolderZip, downloadSharedItem, handleShared } from '../controllers/share.controller.js';
import { apiRateLimiter } from '../middleware/rateLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { downloadFolderZipSchema, downloadSharedItemSchema, handleSharedSchema } from '../utils/validationSchemas.js';

const router = express.Router();

router.use(apiRateLimiter);

router.get('/:token/file/:id', downloadSharedItemSchema, validate, downloadSharedItem);
router.get('/:token/zip', downloadFolderZipSchema, validate, downloadFolderZip);
router.get('/:token', handleSharedSchema, validate, handleShared);

export default router;
