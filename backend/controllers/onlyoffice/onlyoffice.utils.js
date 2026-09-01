import path from 'path';

import jwt from 'jsonwebtoken';

import { getOnlyOfficeSettings, getUserById } from '../../models/user.model.js';
import storage from '../../utils/storageDriver.js';
import { PERMISSIONS, hasPermission } from '../../utils/permissions.js';
import { normalizeOnlyOfficeUrlSafe } from '../../utils/onlyofficeUrl.js';

const BACKEND_URL = process.env.BACKEND_URL;

/**
 * Get OnlyOffice settings from database
 * Uses Redis cache (via getOnlyOfficeSettings) to reduce database queries
 */
async function getOnlyOfficeConfig() {
  const settings = await getOnlyOfficeSettings();
  return {
    jwtSecret: settings.jwtSecret,
    // Every consumer (api.js URL, forcesave command, CSP origin) needs an
    // absolute URL. Normalize defensively here so a legacy scheme-less value
    // stored before validation existed still works without re-entry.
    url: normalizeOnlyOfficeUrlSafe(settings.url),
  };
}

/**
 * OnlyOffice supported file extensions
 */
const ONLYOFFICE_EXTS = new Set([
  '.docx',
  '.doc',
  '.docm',
  '.dotx',
  '.dotm',
  '.dot',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.xlsb',
  '.xltx',
  '.xltm',
  '.csv',
  '.pptx',
  '.ppt',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.pps',
  '.potx',
  '.potm',
  '.odt',
  '.ods',
  '.odp',
  '.pdf',
]);

/**
 * Check if a file is supported by OnlyOffice
 */
function isOnlyOfficeSupported(fileName) {
  if (!fileName) return false;
  const ext = path.extname(fileName).toLowerCase();
  return ONLYOFFICE_EXTS.has(ext);
}

/**
 * Get file type from filename
 */
function getFileTypeFromName(name) {
  const ext = path
    .extname(name || '')
    .toLowerCase()
    .replace(/^\./, '');
  return ext || 'docx';
}

/**
 * Extract the OnlyOffice callback JWT from the body (`token`) or `Authorization: Bearer` header.
 */
function getCallbackToken(req) {
  if (req.body && typeof req.body.token === 'string' && req.body.token) {
    return req.body.token;
  }
  const authz = req.headers?.authorization;
  if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
    return authz.slice('Bearer '.length).trim() || null;
  }
  return null;
}

/**
 * Verify an OnlyOffice callback JWT and return the signed payload (or null if invalid).
 * Header-mode tokens nest the body under `payload`, so unwrap that case.
 */
function verifyCallbackToken(req, jwtSecret) {
  const token = getCallbackToken(req);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    if (decoded && typeof decoded.payload === 'object' && decoded.payload !== null) {
      return decoded.payload;
    }
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Build signed JWT token for file access (per-user encryption context).
 * Token includes userId so serveFile can enforce strict DB permissions:
 * file is only served when id AND user_id match the token.
 */
async function buildSignedFileToken(fileId, userId) {
  const config = await getOnlyOfficeConfig();
  if (!config.jwtSecret) return null;
  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign({ fileId, userId }, config.jwtSecret, { expiresIn: '10m', algorithm: 'HS256' });
}

/**
 * Get ONLYOFFICE JavaScript API URL
 */
async function getOnlyofficeJsUrl() {
  const config = await getOnlyOfficeConfig();
  return config.url
    ? `${config.url}/web-apps/apps/api/documents/api.js`
    : 'http://localhost/web-apps/apps/api/documents/api.js';
}

/**
 * Get user name for ONLYOFFICE
 */
async function getUserName(userId) {
  const user = await getUserById(userId);
  return user?.name || user?.email || 'User';
}

/**
 * Detect if request is from a mobile device
 */
function isMobileDevice(req) {
  const userAgent = req?.headers?.['user-agent'] || '';
  const mobilePattern = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i;
  return mobilePattern.test(userAgent);
}

/**
 * Build backend base URL, download URL, and callback URL
 */
function buildOnlyofficeUrls(req, fileId, token) {
  const backendBaseUrl = BACKEND_URL || `${req.protocol}://${req.get('host')}`;
  const downloadUrl = `${backendBaseUrl}/api/onlyoffice/file/${fileId}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
  const callbackUrl = `${backendBaseUrl}/api/onlyoffice/callback`;
  return { backendBaseUrl, downloadUrl, callbackUrl };
}

/**
 * Map the app's theme toggle ('dark' | 'light') to an ONLYOFFICE uiTheme value.
 * Returns undefined for anything else so the document server keeps its own.
 */
function resolveUiTheme(theme) {
  if (theme === 'dark') return 'theme-dark';
  if (theme === 'light') return 'theme-light';
  return undefined;
}

/**
 * Build ONLYOFFICE editor configuration
 */
function buildOnlyofficeConfig(
  file,
  ownerId,
  actor,
  downloadUrl,
  callbackUrl,
  isMobile = false,
  canWrite = true,
  uiTheme
) {
  const fileType = getFileTypeFromName(file.name);
  // The save callback arrives from the OnlyOffice server unauthenticated, so a
  // read-only member has to be held back here, at config time — there is no
  // later point where the role can still be checked.
  const viewOnly = fileType === 'pdf' || !canWrite;

  return {
    document: {
      fileType,
      // The document key carries the *account* the file belongs to: the
      // callback parses it back out to locate and re-encrypt the file, and a
      // sub-user edits the owner's file, not one of its own.
      key: `${ownerId}-${file.id}-${Date.now()}`,
      title: file.name,
      url: downloadUrl,
    },
    editorConfig: {
      callbackUrl,
      mode: viewOnly ? 'view' : 'edit',
      lang: 'en',
      customization: {
        autosave: !viewOnly,
        forcesave: !viewOnly,
        // The app theme is a manual toggle, not the OS preference, so it must
        // be signed into the config here. Without it the editor follows
        // prefers-color-scheme and drifts out of sync with the app.
        ...(uiTheme ? { uiTheme } : {}),
      },
      // Editor presence is the *acting* identity so co-editing shows the
      // individual sub-user rather than the shared account.
      user: {
        id: String(actor.id),
        name: actor.name,
      },
    },
    type: isMobile ? 'mobile' : 'desktop',
  };
}

/**
 * Sign ONLYOFFICE config with JWT token
 */
async function signConfigToken(config) {
  const onlyOfficeConfig = await getOnlyOfficeConfig();
  if (!onlyOfficeConfig.jwtSecret) return null;
  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign(config, onlyOfficeConfig.jwtSecret, { algorithm: 'HS256' });
}

/**
 * Validates file for ONLYOFFICE access (shared validation logic)
 * @param {Object} file - File object from database
 * @param {Function} validateAndResolveFile - Function to validate and resolve file path
 * @param {Function} validateOnlyOfficeMimeType - Function to validate MIME type
 * @returns {Promise<Object>} { valid: boolean, storageKey?: string, isEncrypted?: boolean, error?: string }
 */
async function validateFileForOnlyOffice(file, validateAndResolveFile, validateOnlyOfficeMimeType) {
  if (!file) {
    return { valid: false, error: 'File not found' };
  }

  if (!isOnlyOfficeSupported(file.name)) {
    return { valid: false, error: 'File type is not supported by ONLYOFFICE' };
  }

  const { success, storageKey, isEncrypted, error: fileError } = await validateAndResolveFile(file);
  if (!success) {
    return { valid: false, error: fileError || 'File not found' };
  }

  // Stored files are always encrypted, so MIME validation uses the stored type
  // and never reads content from this key; the key is only a positional arg here.
  const skipContentDetection = storage.useS3(); // S3 key is not a filesystem path
  const mimeValidation = await validateOnlyOfficeMimeType(
    storageKey,
    file.name,
    file.mimeType,
    isEncrypted,
    skipContentDetection
  );
  if (!mimeValidation.valid) {
    return { valid: false, error: mimeValidation.error || 'File type mismatch detected' };
  }

  return { valid: true, storageKey, isEncrypted };
}

/**
 * Assemble everything the browser needs to open a document: the editor config,
 * its signed token, and the URL of the document server's JS bundle.
 *
 * @returns {Promise<{ config: object, configToken: string, onlyofficeJsUrl: string }>}
 */
async function buildEditorSession(req, file, userId) {
  const userName = await getUserName(req.userId);
  const token = await buildSignedFileToken(file.id, userId);
  const { downloadUrl, callbackUrl } = buildOnlyofficeUrls(req, file.id, token);
  const isMobile = isMobileDevice(req);
  const uiTheme = resolveUiTheme(req.query?.theme);
  const config = buildOnlyofficeConfig(
    file,
    userId,
    { id: req.userId, name: userName },
    downloadUrl,
    callbackUrl,
    isMobile,
    hasPermission(req, PERMISSIONS.EDIT),
    uiTheme
  );
  const configToken = await signConfigToken(config);
  const onlyofficeJsUrl = await getOnlyofficeJsUrl();

  return { config, configToken, onlyofficeJsUrl };
}

export {
  BACKEND_URL,
  buildEditorSession,
  getOnlyOfficeConfig,
  isOnlyOfficeSupported,
  getFileTypeFromName,
  getCallbackToken,
  verifyCallbackToken,
  buildSignedFileToken,
  getOnlyofficeJsUrl,
  getUserName,
  isMobileDevice,
  buildOnlyofficeUrls,
  buildOnlyofficeConfig,
  resolveUiTheme,
  signConfigToken,
  validateFileForOnlyOffice,
};
