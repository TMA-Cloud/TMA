/**
 * Sub-user permissions.
 *
 * A sub-user is granted an explicit set of capabilities rather than a coarse
 * role, so an owner can hand out exactly what each person needs — read and
 * download but no deleting, upload but no sharing, and so on.
 *
 * Browsing (listing folders, searching, opening file info) is not a permission:
 * a sub-user who cannot see the account's contents has no reason to exist. Every
 * capability beyond looking is opt-in.
 *
 * The keys here are the source of truth. They are mirrored by a CHECK constraint
 * in migrations/033_add_sub_users.sql, and the catalog below is served to the
 * frontend so labels can never drift out of sync with what the server enforces.
 */

/** Canonical permission keys. */
const PERMISSIONS = {
  DOWNLOAD: 'files.download',
  UPLOAD: 'files.upload',
  EDIT: 'files.edit',
  DELETE: 'files.delete',
  TRASH: 'files.trash',
  SHARE: 'files.share',
};

/**
 * Catalog served to clients: ordered from least to most destructive so the
 * checklist reads top-to-bottom like the Windows permission list it mirrors.
 */
const PERMISSION_CATALOG = [
  {
    key: PERMISSIONS.DOWNLOAD,
    label: 'Download',
    description: 'Download files and folders, and open them in the document viewer',
  },
  {
    key: PERMISSIONS.UPLOAD,
    label: 'Upload & create',
    description: 'Upload files, create folders, and copy existing items',
  },
  {
    key: PERMISSIONS.EDIT,
    label: 'Modify',
    description: 'Rename, move, star, and edit document contents',
  },
  {
    key: PERMISSIONS.SHARE,
    label: 'Share',
    description: 'Create and revoke public share links',
  },
  {
    key: PERMISSIONS.DELETE,
    label: 'Move to trash',
    description: 'Send files and folders to the trash',
  },
  {
    key: PERMISSIONS.TRASH,
    label: 'Manage trash',
    description: 'Restore items from the trash and delete them permanently',
  },
];

const ALL_PERMISSIONS = PERMISSION_CATALOG.map(p => p.key);

/** Preset used by the "Full access" button in the UI. */
const FULL_ACCESS_PERMISSIONS = [...ALL_PERMISSIONS];

/** Preset used by the "View only" button in the UI. */
const VIEW_ONLY_PERMISSIONS = [PERMISSIONS.DOWNLOAD];

/**
 * Normalise a caller-supplied permission list: drop unknown keys, remove
 * duplicates, and return them in catalog order so stored rows are comparable.
 * @param {unknown} permissions
 * @returns {string[]}
 */
function normalizePermissions(permissions) {
  if (!Array.isArray(permissions)) return [];
  const requested = new Set(permissions.filter(p => typeof p === 'string'));
  return ALL_PERMISSIONS.filter(key => requested.has(key));
}

/**
 * True when every supplied key is a known permission.
 * @param {unknown} permissions
 * @returns {boolean}
 */
function arePermissionsValid(permissions) {
  return Array.isArray(permissions) && permissions.every(p => typeof p === 'string' && ALL_PERMISSIONS.includes(p));
}

/**
 * Check a capability for the acting request.
 *
 * Owners are not consulted against the permission list at all — they hold every
 * capability over their own account by definition.
 *
 * @param {Object} req - Express request, after the auth middleware has run
 * @param {string} permission - One of PERMISSIONS
 * @returns {boolean}
 */
function hasPermission(req, permission) {
  if (!req?.isSubUser) return true;
  return Array.isArray(req.permissions) && req.permissions.includes(permission);
}

export {
  PERMISSIONS,
  PERMISSION_CATALOG,
  ALL_PERMISSIONS,
  FULL_ACCESS_PERMISSIONS,
  VIEW_ONLY_PERMISSIONS,
  normalizePermissions,
  arePermissionsValid,
  hasPermission,
};
