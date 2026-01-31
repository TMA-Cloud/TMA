const jwt = require('jsonwebtoken');
const { validateAndResolveFile, streamEncryptedFile, streamUnencryptedFile } = require('../../utils/fileDownload');
const { validateSingleId } = require('../../utils/controllerHelpers');
const { logger } = require('../../config/logger');
const { getOnlyOfficeConfig } = require('./onlyoffice.utils');
const { getFile } = require('../../models/file.model');

/**
 * Serve file to ONLYOFFICE server
 * This endpoint is public but requires a valid signed token
 */
async function serveFile(req, res) {
  try {
    const { valid, id, error } = validateSingleId(req);
    if (!valid) {
      return res.status(400).json({ error });
    }
    const token = req.query.t;

    // Add CORS headers for ONLYOFFICE server
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // SECURITY: Require JWT secret to be configured for file serving
    // Without it, tokens cannot be cryptographically verified
    const onlyOfficeConfig = await getOnlyOfficeConfig();
    if (!onlyOfficeConfig.jwtSecret) {
      logger.warn('[ONLYOFFICE] File serving disabled - OnlyOffice JWT secret not configured');
      return res.status(424).json({ error: 'OnlyOffice integration not configured securely' });
    }

    // SECURITY: Always require a valid token to serve files
    // This prevents unauthorized file access if someone knows/guesses file IDs
    if (!token) {
      logger.error('[ONLYOFFICE] Missing token for file', id);
      return res.status(401).json({ error: 'Missing token' });
    }

    // Validate token signature and require per-user context (userId in payload)
    let payload;
    try {
      const decodedToken = decodeURIComponent(String(token));
      payload = jwt.verify(decodedToken, onlyOfficeConfig.jwtSecret, { algorithms: ['HS256'] });
      if (payload.fileId !== id) {
        logger.error('[ONLYOFFICE] Token fileId mismatch', { tokenFileId: payload.fileId, requestedId: id });
        return res.status(401).json({ error: 'Invalid token' });
      }
      if (!payload.userId) {
        logger.error('[ONLYOFFICE] Token missing userId (per-user context required)');
        return res.status(401).json({ error: 'Invalid token' });
      }
    } catch (e) {
      logger.error('[ONLYOFFICE] Token verification failed', e.message);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Strict DB permission: fetch file only when id AND user_id match token (User A cannot download User B's file by guessing ID)
    const fileRow = await getFile(id, payload.userId);
    if (!fileRow) {
      logger.error('[ONLYOFFICE] File not found or access denied', { id, userId: payload.userId });
      return res.status(404).json({ error: 'File not found' });
    }
    const { success, filePath, storageKey, isEncrypted, error: fileError } = await validateAndResolveFile(fileRow);
    if (!success) {
      logger.error('[ONLYOFFICE] File validation failed', id, fileError);
      return res.status(404).json({ error: fileError || 'File not found' });
    }

    const pathOrKey = filePath || storageKey;

    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRow.name)}"`);
    res.type(fileRow.mimeType || 'application/octet-stream');

    if (isEncrypted) {
      return streamEncryptedFile(res, pathOrKey, fileRow.name, fileRow.mimeType || 'application/octet-stream');
    }

    return streamUnencryptedFile(res, pathOrKey, fileRow.name, fileRow.mimeType || 'application/octet-stream');
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Error serving file');
    res.status(500).json({ error: 'Server error' });
  }
}

module.exports = {
  serveFile,
};
