const path = require('path');
const jwt = require('jsonwebtoken');
const { getUserById, getOnlyOfficeSettings } = require('../../models/user.model');

const BACKEND_URL = process.env.BACKEND_URL;

/**
 * Get OnlyOffice settings from database
 * Uses Redis cache (via getOnlyOfficeSettings) to reduce database queries
 */
async function getOnlyOfficeConfig() {
  const settings = await getOnlyOfficeSettings();
  return {
    jwtSecret: settings.jwtSecret,
    url: settings.url,
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
 * Build signed JWT token for file access
 */
async function buildSignedFileToken(fileId) {
  const config = await getOnlyOfficeConfig();
  if (!config.jwtSecret) return null;
  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign({ fileId }, config.jwtSecret, { expiresIn: '10m', algorithm: 'HS256' });
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
 * Build ONLYOFFICE editor configuration
 */
function buildOnlyofficeConfig(file, userId, userName, downloadUrl, callbackUrl, isMobile = false) {
  const fileType = getFileTypeFromName(file.name);
  const viewOnly = fileType === 'pdf';

  return {
    document: {
      fileType,
      key: `${file.id}-${Date.now()}`,
      title: file.name,
      url: downloadUrl,
    },
    editorConfig: {
      callbackUrl,
      mode: viewOnly ? 'view' : 'edit',
      lang: 'en',
      customization: {
        autosave: !viewOnly,
      },
      user: {
        id: String(userId),
        name: userName,
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

module.exports = {
  BACKEND_URL,
  getOnlyOfficeConfig,
  isOnlyOfficeSupported,
  getFileTypeFromName,
  buildSignedFileToken,
  getOnlyofficeJsUrl,
  getUserName,
  isMobileDevice,
  buildOnlyofficeUrls,
  buildOnlyofficeConfig,
  signConfigToken,
};
