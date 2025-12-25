const { validateId } = require('../../utils/validation');
const { getFile } = require('../../models/file.model');
const { logger } = require('../../config/logger');
const {
  ONLYOFFICE_JWT_SECRET,
  getUserName,
  buildSignedFileToken,
  buildOnlyofficeUrls,
  isMobileDevice,
  buildOnlyofficeConfig,
  signConfigToken,
  getOnlyofficeJsUrl,
} = require('./onlyoffice.utils');

/**
 * Get ONLYOFFICE editor configuration for a file
 */
async function getConfig(req, res) {
  try {
    // SECURITY: Require JWT secret for OnlyOffice integration
    if (!ONLYOFFICE_JWT_SECRET) {
      return res.status(503).json({ message: 'OnlyOffice integration not configured. Set ONLYOFFICE_JWT_SECRET.' });
    }

    const fileId = validateId(req.params.id);
    if (!fileId) {
      return res.status(400).json({ message: 'Invalid file ID' });
    }
    const userId = req.userId;

    const file = await getFile(fileId, userId);
    if (!file) return res.status(404).json({ message: 'File not found' });

    const userName = await getUserName(userId);
    const token = buildSignedFileToken(file.id);
    const { downloadUrl, callbackUrl } = buildOnlyofficeUrls(req, file.id, token);
    const isMobile = isMobileDevice(req);
    const config = buildOnlyofficeConfig(file, userId, userName, downloadUrl, callbackUrl, isMobile);
    const tokenForConfig = signConfigToken(config);
    const onlyofficeJsUrl = getOnlyofficeJsUrl();

    res.json({ config, token: tokenForConfig, onlyofficeJsUrl });
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Config error');
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  getConfig,
};
