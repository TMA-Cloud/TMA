import { logger } from '../../config/logger.js';
import { getFile } from '../../models/file.model.js';
import { recordAccess } from '../../services/accessTracker.js';
import { registerOpenDocument } from '../../services/onlyofficeAutoSave.js';
import { PERMISSIONS, hasPermission } from '../../utils/permissions.js';
import { validateAndResolveFile } from '../../utils/fileDownload.js';
import { validateOnlyOfficeMimeType } from '../../utils/mimeTypeDetection.js';

import {
  buildOnlyofficeConfig,
  buildOnlyofficeUrls,
  buildSignedFileToken,
  getOnlyOfficeConfig,
  getOnlyofficeJsUrl,
  getUserName,
  isMobileDevice,
  signConfigToken,
  validateFileForOnlyOffice,
} from './onlyoffice.utils.js';

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

    const { id: fileId } = req.params;
    // Files belong to the account owner; a sub-user edits the owner's copy.
    const userId = req.ownerId;

    const file = await getFile(fileId, userId);
    const validation = await validateFileForOnlyOffice(file, validateAndResolveFile, validateOnlyOfficeMimeType);

    if (!validation.valid) {
      if (!file) {
        return res.status(404).json({ message: validation.error });
      }
      logger.warn({ fileId, fileName: file.name, error: validation.error }, '[ONLYOFFICE] Validation failed');
      return res.status(400).json({ message: validation.error });
    }

    const userName = await getUserName(req.userId);
    const token = await buildSignedFileToken(file.id, userId);
    const { downloadUrl, callbackUrl } = buildOnlyofficeUrls(req, file.id, token);
    const isMobile = isMobileDevice(req);
    const config = buildOnlyofficeConfig(
      file,
      userId,
      { id: req.userId, name: userName },
      downloadUrl,
      callbackUrl,
      isMobile,
      hasPermission(req, PERMISSIONS.EDIT)
    );
    const tokenForConfig = await signConfigToken(config);
    const onlyofficeJsUrl = await getOnlyofficeJsUrl();

    // Register document for auto-save
    registerOpenDocument(config.document.key, file.id, userId);

    // Opening the document is the read. The document server's own fetches of
    // /onlyoffice/file are a consequence of this one action, so they are not
    // counted again.
    recordAccess(file.id, userId);

    res.json({ config, token: tokenForConfig, onlyofficeJsUrl });
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Config error');
    res.status(500).json({ message: 'Server error' });
  }
}

export { getConfig };
