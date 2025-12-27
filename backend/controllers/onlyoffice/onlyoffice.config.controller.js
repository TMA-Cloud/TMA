const { validateId } = require('../../utils/validation');
const { getFile } = require('../../models/file.model');
const { logger } = require('../../config/logger');
const {
  getOnlyOfficeConfig,
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
    // SECURITY: Require both JWT secret and URL for OnlyOffice integration
    const onlyOfficeConfig = await getOnlyOfficeConfig();
    if (!onlyOfficeConfig.jwtSecret || !onlyOfficeConfig.url) {
      return res.status(424).json({ message: 'OnlyOffice integration not configured. Configure it in Settings.' });
    }

    const fileId = validateId(req.params.id);
    if (!fileId) {
      return res.status(400).json({ message: 'Invalid file ID' });
    }
    const userId = req.userId;

    const file = await getFile(fileId, userId);
    if (!file) return res.status(404).json({ message: 'File not found' });

    const userName = await getUserName(userId);
    const token = await buildSignedFileToken(file.id);
    const { downloadUrl, callbackUrl } = buildOnlyofficeUrls(req, file.id, token);
    const isMobile = isMobileDevice(req);
    const config = buildOnlyofficeConfig(file, userId, userName, downloadUrl, callbackUrl, isMobile);
    const tokenForConfig = await signConfigToken(config);
    const onlyofficeJsUrl = await getOnlyofficeJsUrl();

    res.json({ config, token: tokenForConfig, onlyofficeJsUrl });
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Config error');
    res.status(500).json({ message: 'Server error' });
  }
}

module.exports = {
  getConfig,
};
