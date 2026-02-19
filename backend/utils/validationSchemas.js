const { body, param } = require('express-validator');

const MAX_EMAIL_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 100;
// Allow letters, numbers, underscore, dot, hyphen, and spaces (no path/control chars)
const FILE_NAME_REGEX = /^[a-zA-Z0-9_.\s-]+$/;

const signupSchema = [
  body('email')
    .isEmail()
    .withMessage('Invalid email format')
    .isLength({ max: MAX_EMAIL_LENGTH })
    .withMessage(`Email must not exceed ${MAX_EMAIL_LENGTH} characters`)
    .normalizeEmail(),
  body('password')
    .isLength({ min: 6, max: MAX_PASSWORD_LENGTH })
    .withMessage(`Password must be between 6 and ${MAX_PASSWORD_LENGTH} characters`),
  body('name')
    .optional()
    .isString()
    .withMessage('Name must be a string')
    .isLength({ max: MAX_NAME_LENGTH })
    .withMessage(`Name must not exceed ${MAX_NAME_LENGTH} characters`)
    .trim()
    .escape(),
];

const loginSchema = [
  body('email')
    .isEmail()
    .withMessage('Invalid email format')
    .isLength({ max: MAX_EMAIL_LENGTH })
    .withMessage(`Email must not exceed ${MAX_EMAIL_LENGTH} characters`)
    .normalizeEmail(),
  body('password')
    .isLength({ max: MAX_PASSWORD_LENGTH })
    .withMessage(`Password must not exceed ${MAX_PASSWORD_LENGTH} characters`),
];

const addFolderSchema = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Folder name is required')
    .matches(FILE_NAME_REGEX)
    .withMessage('Invalid folder name')
    .isLength({ max: MAX_NAME_LENGTH })
    .withMessage(`Folder name must not exceed ${MAX_NAME_LENGTH} characters`),
  body('parentId').optional({ nullable: true }).isString().withMessage('Parent ID must be a string'),
];

const renameFileSchema = [
  body('id').notEmpty().withMessage('File ID is required').isString().withMessage('File ID must be a string'),
  body('name')
    .trim()
    .notEmpty()
    .withMessage('New name is required')
    .matches(FILE_NAME_REGEX)
    .withMessage('Invalid file name')
    .isLength({ max: MAX_NAME_LENGTH })
    .withMessage(`File name must not exceed ${MAX_NAME_LENGTH} characters`),
];

const downloadFileSchema = [
  param('id').notEmpty().withMessage('File ID is required').isString().withMessage('File ID must be a string'),
];

const downloadFilesBulkSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
];

const moveFilesSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
  body('parentId').optional({ nullable: true }).isString().withMessage('Parent ID must be a string'),
];

const copyFilesSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
  body('parentId').optional({ nullable: true }).isString().withMessage('Parent ID must be a string'),
];

const starFilesSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
  body('starred').isBoolean().withMessage('Starred must be a boolean'),
];

const shareFilesSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
  body('shared').isBoolean().withMessage('Shared must be a boolean'),
  body('expiry').optional().isIn(['7d', '30d', 'never']).withMessage('Expiry must be 7d, 30d, or never'),
];

const getShareLinksSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
];

const linkParentShareSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
];

const deleteFilesSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
];

const restoreFilesSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
];

const deleteForeverSchema = [
  body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
  body('ids.*').isString().withMessage('All file IDs must be strings'),
];

const toggleSignupSchema = [body('enabled').isBoolean().withMessage('Enabled must be a boolean')];

const updateOnlyOfficeConfigSchema = [
  body('jwtSecret').optional({ nullable: true }).isString().withMessage('JWT secret must be a string'),
  body('url').optional({ nullable: true }).isURL().withMessage('Invalid URL format'),
];

const updateShareBaseUrlConfigSchema = [
  body('url').optional({ nullable: true }).isURL().withMessage('Invalid URL format'),
];

// Max upload size in bytes (1MB to 100GB)
const updateMaxUploadSizeConfigSchema = [
  body('maxBytes')
    .isInt({ min: 1048576, max: 107374182400 })
    .withMessage('Max upload size must be between 1 MB and 100 GB (in bytes)')
    .toInt(),
];

const updateUserStorageLimitSchema = [
  body('targetUserId')
    .notEmpty()
    .withMessage('Target user ID is required')
    .isString()
    .withMessage('Target user ID must be a string'),
  body('storageLimit')
    .optional({ nullable: true })
    .isInt({ min: 1, max: Number.MAX_SAFE_INTEGER })
    .withMessage('Storage limit must be a positive integer or null'),
];

const getOnlyOfficeConfigSchema = [
  param('id').notEmpty().withMessage('File ID is required').isString().withMessage('File ID must be a string'),
];

const handleSharedSchema = [
  param('token').notEmpty().withMessage('Token is required').isString().withMessage('Token must be a string'),
];

const downloadFolderZipSchema = [
  param('token').notEmpty().withMessage('Token is required').isString().withMessage('Token must be a string'),
];

const downloadSharedItemSchema = [
  param('token').notEmpty().withMessage('Token is required').isString().withMessage('Token must be a string'),
  param('id').notEmpty().withMessage('File ID is required').isString().withMessage('File ID must be a string'),
];

/** Check storage before upload (fileSize in bytes) */
const checkUploadStorageSchema = [
  body('fileSize').isInt({ min: 0 }).withMessage('fileSize must be a non-negative integer').toInt(),
];

module.exports = {
  signupSchema,
  loginSchema,
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
  toggleSignupSchema,
  updateOnlyOfficeConfigSchema,
  updateShareBaseUrlConfigSchema,
  updateMaxUploadSizeConfigSchema,
  updateUserStorageLimitSchema,
  getOnlyOfficeConfigSchema,
  handleSharedSchema,
  downloadFolderZipSchema,
  downloadSharedItemSchema,
  checkUploadStorageSchema,
};
