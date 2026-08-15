import { body, param, query } from 'express-validator';

import { ALL_PERMISSIONS } from './permissions.js';

const MAX_EMAIL_LENGTH = 254;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const MAX_NAME_LENGTH = 100;
// Allow letters (including Unicode), numbers, and special characters; forbid path/control and Windows-reserved
// eslint-disable-next-line no-control-regex -- Intentional: exclude control chars for security
const FILE_NAME_REGEX = /^[^\x00-\x1F\x7F/\\:*?"<>|]+$/;

const signupSchema = [
  body('email')
    .isEmail()
    .withMessage('Invalid email format')
    .isLength({ max: MAX_EMAIL_LENGTH })
    .withMessage(`Email must not exceed ${MAX_EMAIL_LENGTH} characters`)
    .normalizeEmail(),
  body('password')
    .isLength({ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
    .withMessage(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`),
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

const changePasswordSchema = [
  body('oldPassword')
    .isString()
    .withMessage('Current password is required')
    .isLength({ min: 1, max: MAX_PASSWORD_LENGTH })
    .withMessage(`Current password must not exceed ${MAX_PASSWORD_LENGTH} characters`),
  body('newPassword')
    .isString()
    .withMessage('New password is required')
    .isLength({ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
    .withMessage(`New password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`),
  body('mfaCode')
    .optional()
    .isString()
    .withMessage('MFA code must be a string')
    .isLength({ min: 6, max: 20 })
    .withMessage('MFA code must be between 6 and 20 characters'),
];

const addFolderSchema = [
  body('name')
    .trim()
    .notEmpty()
    .withMessage('Folder name is required')
    .matches(FILE_NAME_REGEX)
    .withMessage('Invalid folder name (forbidden: / \\ : * ? " < > |)')
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
    .withMessage('Invalid file name (forbidden: / \\ : * ? " < > |)')
    .isLength({ max: MAX_NAME_LENGTH })
    .withMessage(`File name must not exceed ${MAX_NAME_LENGTH} characters`),
];

const downloadFileSchema = [
  param('id').notEmpty().withMessage('File ID is required').isString().withMessage('File ID must be a string'),
];

/**
 * Factory for the common `body('ids')` + `body('ids.*')` validation pair
 * used by every bulk file operation. Extend with `...idsArrayRules(), ...extra` to add more fields.
 */
function idsArrayRules() {
  return [
    body('ids').isArray({ min: 1 }).withMessage('File IDs must be an array with at least one ID'),
    body('ids.*').isString().withMessage('All file IDs must be strings'),
  ];
}

const downloadFilesBulkSchema = idsArrayRules();

const moveFilesSchema = [
  ...idsArrayRules(),
  body('parentId').optional({ nullable: true }).isString().withMessage('Parent ID must be a string'),
];

const copyFilesSchema = [
  ...idsArrayRules(),
  body('parentId').optional({ nullable: true }).isString().withMessage('Parent ID must be a string'),
];

const starFilesSchema = [...idsArrayRules(), body('starred').isBoolean().withMessage('Starred must be a boolean')];

const shareFilesSchema = [
  // Allow a single ID string or an array of IDs, but always normalize to a non-empty array.
  body('ids')
    .custom(value => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        return true;
      }
      return false;
    })
    .withMessage('File IDs must be an array with at least one ID'),
  body('ids').customSanitizer(value => {
    if (Array.isArray(value)) {
      return value.map(String);
    }
    if (typeof value === 'string') {
      return [value];
    }
    return value;
  }),
  // Be tolerant of different boolean representations (true/false, "true"/"false").
  // Default is handled in the controller, but we still validate shape here.
  body('shared')
    .optional()
    .custom(val => typeof val === 'boolean' || val === 'true' || val === 'false')
    .withMessage('Shared must be a boolean')
    .customSanitizer(val => val === 'true' || val === true),
  body('expiry').optional().isIn(['7d', '30d', 'never']).withMessage('Expiry must be 7d, 30d, or never'),
];

const getShareLinksSchema = idsArrayRules();
const linkParentShareSchema = idsArrayRules();
const deleteFilesSchema = idsArrayRules();
const restoreFilesSchema = idsArrayRules();
const deleteForeverSchema = idsArrayRules();

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

const updateHideFileExtensionsConfigSchema = [body('hidden').isBoolean().withMessage('Hidden must be a boolean')];

const updateElectronOnlyAccessConfigSchema = [body('enabled').isBoolean().withMessage('Enabled must be a boolean')];

const updatePasswordChangeConfigSchema = [body('enabled').isBoolean().withMessage('Enabled must be a boolean')];

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

// Grace window bounds mirror MIN/MAX_GRACE_MINUTES in file.orphan.model.js.
// The floor is what keeps in-flight uploads and pastes out of the results.
const ORPHAN_MIN_GRACE_MINUTES = 60;
const ORPHAN_MAX_GRACE_MINUTES = 525600;
const ORPHAN_MAX_BATCH = 500;

const scanOrphansSchema = [
  query('graceMinutes')
    .optional()
    .isInt({ min: ORPHAN_MIN_GRACE_MINUTES, max: ORPHAN_MAX_GRACE_MINUTES })
    .withMessage(`Grace window must be between ${ORPHAN_MIN_GRACE_MINUTES} minutes and 1 year`)
    .toInt(),
];

const deleteOrphansSchema = [
  body('storageKeys')
    .optional()
    .isArray({ max: ORPHAN_MAX_BATCH })
    .withMessage(`Provide at most ${ORPHAN_MAX_BATCH} storage keys per request`),
  body('storageKeys.*').isString().withMessage('Storage keys must be strings'),
  body('fileIds')
    .optional()
    .isArray({ max: ORPHAN_MAX_BATCH })
    .withMessage(`Provide at most ${ORPHAN_MAX_BATCH} file IDs per request`),
  body('fileIds.*').isString().withMessage('File IDs must be strings'),
  body('graceMinutes')
    .optional()
    .isInt({ min: ORPHAN_MIN_GRACE_MINUTES, max: ORPHAN_MAX_GRACE_MINUTES })
    .withMessage(`Grace window must be between ${ORPHAN_MIN_GRACE_MINUTES} minutes and 1 year`)
    .toInt(),
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

/**
 * Permissions an owner may grant a sub-user. Imported from the catalog so a new
 * capability only has to be declared in one place.
 */
const permissionsBody = () =>
  body('permissions')
    .isArray({ max: ALL_PERMISSIONS.length })
    .withMessage('Permissions must be an array')
    .bail()
    .custom(value => value.every(p => ALL_PERMISSIONS.includes(p)))
    .withMessage(`Permissions must be drawn from: ${ALL_PERMISSIONS.join(', ')}`);

const createSubUserSchema = [
  body('email')
    .isEmail()
    .withMessage('Invalid email format')
    .isLength({ max: MAX_EMAIL_LENGTH })
    .withMessage(`Email must not exceed ${MAX_EMAIL_LENGTH} characters`)
    .normalizeEmail(),
  body('password')
    .isLength({ min: MIN_PASSWORD_LENGTH, max: MAX_PASSWORD_LENGTH })
    .withMessage(`Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`),
  body('name')
    .isString()
    .withMessage('Name is required')
    .bail()
    .trim()
    .notEmpty()
    .withMessage('Name is required')
    .isLength({ max: MAX_NAME_LENGTH })
    .withMessage(`Name must not exceed ${MAX_NAME_LENGTH} characters`)
    .escape(),
  permissionsBody(),
];

const updateSubUserSchema = [
  param('id').notEmpty().withMessage('Sub-user ID is required').isString().withMessage('Sub-user ID must be a string'),
  permissionsBody(),
];

const subUserIdParamSchema = [
  param('id').notEmpty().withMessage('Sub-user ID is required').isString().withMessage('Sub-user ID must be a string'),
];

export {
  signupSchema,
  loginSchema,
  changePasswordSchema,
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
  updateHideFileExtensionsConfigSchema,
  updateUserStorageLimitSchema,
  createSubUserSchema,
  updateSubUserSchema,
  subUserIdParamSchema,
  scanOrphansSchema,
  deleteOrphansSchema,
  getOnlyOfficeConfigSchema,
  handleSharedSchema,
  downloadFolderZipSchema,
  downloadSharedItemSchema,
  checkUploadStorageSchema,
  updateElectronOnlyAccessConfigSchema,
  updatePasswordChangeConfigSchema,
};
