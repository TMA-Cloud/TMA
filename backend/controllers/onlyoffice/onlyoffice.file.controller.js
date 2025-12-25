const jwt = require('jsonwebtoken');
const { validateId } = require('../../utils/validation');
const { validateAndResolveFile } = require('../../utils/fileDownload');
const { logger } = require('../../config/logger');
const { ONLYOFFICE_JWT_SECRET } = require('./onlyoffice.utils');

/**
 * Serve file to ONLYOFFICE server
 * This endpoint is public but requires a valid signed token
 */
async function serveFile(req, res) {
  try {
    const id = validateId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }
    const token = req.query.t;

    // Add CORS headers for ONLYOFFICE server
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // SECURITY: Require JWT secret to be configured for file serving
    // Without it, tokens cannot be cryptographically verified
    if (!ONLYOFFICE_JWT_SECRET) {
      logger.error('[ONLYOFFICE] File serving disabled - ONLYOFFICE_JWT_SECRET not configured');
      return res.status(503).json({ error: 'OnlyOffice integration not configured securely' });
    }

    // SECURITY: Always require a valid token to serve files
    // This prevents unauthorized file access if someone knows/guesses file IDs
    if (!token) {
      logger.error('[ONLYOFFICE] Missing token for file', id);
      return res.status(401).json({ error: 'Missing token' });
    }

    // Validate token signature
    try {
      // Decode token (it's already URL encoded)
      const decodedToken = decodeURIComponent(String(token));
      // Explicitly specify allowed algorithms to prevent algorithm confusion attacks
      const payload = jwt.verify(decodedToken, ONLYOFFICE_JWT_SECRET, { algorithms: ['HS256'] });
      if (payload.fileId !== id) {
        logger.error('[ONLYOFFICE] Token fileId mismatch', { tokenFileId: payload.fileId, requestedId: id });
        return res.status(401).json({ error: 'Invalid token' });
      }
    } catch (e) {
      logger.error('[ONLYOFFICE] Token verification failed', e.message);
      return res.status(401).json({ error: 'Invalid token' });
    }

    // Fetch file path directly from DB by id
    const db = require('../../config/db');
    const result = await db.query('SELECT name, mime_type AS "mimeType", path FROM files WHERE id = $1', [id]);
    const fileRow = result.rows[0];
    if (!fileRow) {
      logger.error('[ONLYOFFICE] File not found in DB', id);
      return res.status(404).json({ error: 'File not found' });
    }
    const { success, filePath, error } = validateAndResolveFile(fileRow);
    if (!success) {
      logger.error('[ONLYOFFICE] File validation failed', id, error);
      return res.status(404).json({ error: error || 'File not found' });
    }

    // Set appropriate headers
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRow.name)}"`);
    res.type(fileRow.mimeType || 'application/octet-stream');
    res.sendFile(filePath, err => {
      if (err) {
        logger.error({ err, fileId: id }, '[ONLYOFFICE] Error sending file');
        if (!res.headersSent) {
          res.status(500).json({ error: 'Error sending file' });
        }
      }
    });
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Error serving file');
    res.status(500).json({ error: 'Server error' });
  }
}

module.exports = {
  serveFile,
};
