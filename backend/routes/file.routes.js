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
  listRecent,
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
import { requirePermission } from '../middleware/accountRole.middleware.js';
import { streamUploadToS3 } from '../middleware/streamUploadToS3.middleware.js';
import { apiRateLimiter, sseConnectionLimiter, uploadRateLimiter } from '../middleware/rateLimit.middleware.js';
import { checkStorageLimit } from '../middleware/storageLimit.middleware.js';
import { validate } from '../middleware/validation.middleware.js';
import { PERMISSIONS } from '../utils/permissions.js';

/** Stream directly to the bucket with the admin-configurable max file size. */
function uploadSingle() {
  return streamUploadToS3('single');
}
function uploadBulk() {
  return streamUploadToS3('bulk');
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

// Browsing is open to every member of the account: a sub-user who cannot see
// the contents has no reason to exist. Note that several of these are POSTs
// because they take a body, not because they mutate anything.
// SSE endpoint with dedicated connection limiting
router.get('/events', sseConnectionLimiter, streamFileEvents);
router.get('/', listFiles);
router.get('/stats', getFileStats);
router.get('/:id/info', getFileInfo);
router.get('/search', searchFiles);
router.get('/recent', listRecent);
router.get('/starred', listStarred);
router.get('/shared', listShared);
router.get('/trash', listTrash);

// Everything below needs an explicit grant. Each guard runs before any upload
// middleware so a rejected request never streams its body.
const canDownload = requirePermission(PERMISSIONS.DOWNLOAD);
const canUpload = requirePermission(PERMISSIONS.UPLOAD);
const canEdit = requirePermission(PERMISSIONS.EDIT);
const canShare = requirePermission(PERMISSIONS.SHARE);
const canDelete = requirePermission(PERMISSIONS.DELETE);
const canManageTrash = requirePermission(PERMISSIONS.TRASH);

router.post('/download/bulk', canDownload, downloadFilesBulkSchema, validate, downloadFilesBulk);
router.get('/:id/download', canDownload, downloadFileSchema, validate, downloadFile);

router.post('/folder', canUpload, addFolderSchema, validate, addFolder);
router.post('/upload/check', canUpload, uploadRateLimiter, checkUploadStorageSchema, validate, checkUploadStorage);
router.post('/upload', canUpload, uploadRateLimiter, checkStorageLimit, uploadSingle(), uploadFile);
router.post('/upload/bulk', canUpload, uploadRateLimiter, checkStorageLimit, uploadBulk(), uploadFilesBulk);
// Copy creates new rows and consumes quota, so it is an upload rather than an edit.
router.post('/copy', canUpload, copyFilesSchema, validate, copyFiles);

router.post('/move', canEdit, moveFilesSchema, validate, moveFiles);
router.post('/rename', canEdit, renameFileSchema, validate, renameFile);
router.post('/star', canEdit, starFilesSchema, validate, starFiles);
router.post('/:id/replace', canEdit, uploadRateLimiter, uploadSingle(), replaceFileContents);

router.post('/share', canShare, shareFilesSchema, validate, shareFiles);
router.post('/link-parent-share', canShare, linkParentShareSchema, validate, linkParentShare);
// Reading a link is how "Copy Link" hands account content to outsiders, so it
// belongs with the share grant rather than with the open browse routes.
router.post('/share/links', canShare, getShareLinksSchema, validate, getShareLinks);

router.post('/delete', canDelete, deleteFilesSchema, validate, deleteFiles);

router.post('/trash/restore', canManageTrash, restoreFilesSchema, validate, restoreFiles);
router.post('/trash/delete', canManageTrash, deleteForeverSchema, validate, deleteForever);
router.post('/trash/empty', canManageTrash, emptyTrash);

// Upload a new file derived from an existing one (e.g. "Save as PDF" from desktop editor)
// Derived files also stream directly to the bucket.
router.post('/:id/derived', canUpload, uploadRateLimiter, uploadSingle(), uploadDerivedFile);

export default router;
