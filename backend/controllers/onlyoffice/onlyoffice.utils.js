const path = require('path');
const jwt = require('jsonwebtoken');
const { getUserById } = require('../../models/user.model');
const { logger } = require('../../config/logger');

const ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET;
const ONLYOFFICE_URL = process.env.ONLYOFFICE_URL;
const BACKEND_URL = process.env.BACKEND_URL;

// SECURITY: Warn at startup if JWT secret is missing
// OnlyOffice file serving will be disabled without it
if (!ONLYOFFICE_JWT_SECRET) {
  logger.warn(
    '[SECURITY] ONLYOFFICE_JWT_SECRET not set. OnlyOffice file serving endpoint will reject all requests. Set this secret to enable document editing.'
  );
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
function buildSignedFileToken(fileId) {
  if (!ONLYOFFICE_JWT_SECRET) return null;
  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign({ fileId }, ONLYOFFICE_JWT_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
}

/**
 * Get ONLYOFFICE JavaScript API URL
 */
function getOnlyofficeJsUrl() {
  return ONLYOFFICE_URL
    ? `${ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`
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
function signConfigToken(config) {
  if (!ONLYOFFICE_JWT_SECRET) return null;
  // Explicitly specify algorithm to prevent algorithm confusion attacks
  return jwt.sign(config, ONLYOFFICE_JWT_SECRET, { algorithm: 'HS256' });
}

module.exports = {
  ONLYOFFICE_JWT_SECRET,
  ONLYOFFICE_URL,
  BACKEND_URL,
  getFileTypeFromName,
  buildSignedFileToken,
  getOnlyofficeJsUrl,
  getUserName,
  isMobileDevice,
  buildOnlyofficeUrls,
  buildOnlyofficeConfig,
  signConfigToken,
};
