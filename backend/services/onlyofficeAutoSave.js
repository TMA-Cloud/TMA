const https = require('https');
const http = require('http');
const { URL } = require('url');
const jwt = require('jsonwebtoken');
const { logger } = require('../config/logger');
const { getOnlyOfficeConfig } = require('../controllers/onlyoffice/onlyoffice.utils');

// Track open documents: Map<documentKey, { fileId, userId }>
const openDocuments = new Map();
let autoSaveInterval = null;
const AUTO_SAVE_INTERVAL = 30000; // 30 seconds

/**
 * Register a document as open
 */
function registerOpenDocument(documentKey, fileId, userId) {
  openDocuments.set(documentKey, { fileId, userId });

  if (!autoSaveInterval) {
    autoSaveInterval = setInterval(triggerAutoSaves, AUTO_SAVE_INTERVAL);
    logger.debug('[ONLYOFFICE-AUTOSAVE] Auto-save started');
  }
}

/**
 * Unregister a document (when closed)
 */
function unregisterOpenDocument(documentKey) {
  if (openDocuments.delete(documentKey) && openDocuments.size === 0 && autoSaveInterval) {
    clearInterval(autoSaveInterval);
    autoSaveInterval = null;
    logger.debug('[ONLYOFFICE-AUTOSAVE] Auto-save stopped');
  }
}

/**
 * Trigger forcesave for all open documents
 */
async function triggerAutoSaves() {
  if (openDocuments.size === 0) return;

  try {
    const config = await getOnlyOfficeConfig();
    if (!config.url) return;

    const commandUrl = `${config.url}/coauthoring/CommandService.ashx`;
    const urlObj = new URL(commandUrl);
    const isHttps = urlObj.protocol === 'https:';
    const protocol = isHttps ? https : http;

    logger.debug({ count: openDocuments.size, url: commandUrl }, '[ONLYOFFICE-AUTOSAVE] Triggering forcesave');

    const sendForcesave = documentKey =>
      new Promise(resolve => {
        const commandPayload = { c: 'forcesave', key: documentKey };
        let requestBody = commandPayload;
        if (config.jwtSecret) {
          requestBody = { token: jwt.sign(commandPayload, config.jwtSecret, { algorithm: 'HS256' }) };
        }
        const postData = JSON.stringify(requestBody);

        const req = protocol.request(
          {
            hostname: urlObj.hostname,
            port: urlObj.port || (isHttps ? 443 : 80),
            path: urlObj.pathname + urlObj.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(postData),
            },
            timeout: 5000,
            // Allow self-signed certificates (common for OnlyOffice Docker setups)
            rejectUnauthorized: false,
          },
          res => {
            let data = '';
            res.on('data', chunk => {
              data += chunk;
            });
            res.on('end', () => {
              if (res.statusCode !== 200) {
                logger.warn(
                  { documentKey, statusCode: res.statusCode, body: data },
                  '[ONLYOFFICE-AUTOSAVE] Forcesave command failed'
                );
              }
              resolve();
            });
          }
        );
        req.on('error', err => {
          logger.warn({ documentKey, error: err.message }, '[ONLYOFFICE-AUTOSAVE] Request error');
          resolve();
        });
        req.on('timeout', () => {
          req.destroy();
          resolve();
        });
        req.end(postData);
      });

    await Promise.all([...openDocuments.keys()].map(sendForcesave));
  } catch (error) {
    logger.error({ error: error.message }, '[ONLYOFFICE-AUTOSAVE] Error');
  }
}

module.exports = {
  registerOpenDocument,
  unregisterOpenDocument,
};
