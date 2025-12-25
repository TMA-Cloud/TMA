const { validateId } = require('../../utils/validation');
const { getFile } = require('../../models/file.model');
const { logger } = require('../../config/logger');
const { logAuditEvent } = require('../../services/auditLogger');
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
 * Get standalone viewer HTML page for document editing/viewing
 */
async function getViewerPage(req, res) {
  try {
    // SECURITY: Require JWT secret for OnlyOffice integration
    if (!ONLYOFFICE_JWT_SECRET) {
      return res.status(503).send('OnlyOffice integration not configured. Set ONLYOFFICE_JWT_SECRET.');
    }

    const fileId = validateId(req.params.id);
    if (!fileId) {
      return res.status(400).send('Invalid file ID');
    }
    const userId = req.userId;

    const file = await getFile(fileId, userId);
    if (!file) return res.status(404).send('File not found');

    const userName = await getUserName(userId);
    const token = buildSignedFileToken(file.id);
    const { downloadUrl, callbackUrl } = buildOnlyofficeUrls(req, file.id, token);
    const isMobile = isMobileDevice(req);
    const config = buildOnlyofficeConfig(file, userId, userName, downloadUrl, callbackUrl, isMobile);
    const configToken = signConfigToken(config);
    const onlyofficeJsUrl = getOnlyofficeJsUrl();

    // Add token to config if JWT is enabled (for viewer page)
    if (configToken) {
      config.token = configToken;
    }

    // Log audit event for document opening
    await logAuditEvent(
      'document.open',
      {
        status: 'success',
        resourceType: 'file',
        resourceId: file.id,
        metadata: {
          fileName: file.name,
          fileType: config.document.fileType,
          mode: config.editorConfig.mode,
        },
      },
      req
    );

    logger.info(
      { fileId: file.id, fileName: file.name, mode: config.editorConfig.mode },
      'Document opened in ONLYOFFICE'
    );

    // Generate HTML page
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${file.name} - ONLYOFFICE</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { 
      margin: 0;
      padding: 0;
      height: 100vh;
      overflow: hidden;
    }
    body { 
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: #ffffff;
      display: flex;
      flex-direction: column;
      transition: background-color 0.2s;
    }
    body.dark {
      background: #111827;
    }
    .header {
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
      padding: 12px 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-height: 48px;
      flex-shrink: 0;
      z-index: 1000;
      transition: background-color 0.2s, border-color 0.2s;
    }
    body.dark .header {
      background: #1f2937;
      border-bottom-color: #374151;
    }
    .header h1 {
      font-size: 18px;
      font-weight: 600;
      color: #111827;
      flex: 1;
      margin-right: 16px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.2s;
    }
    body.dark .header h1 {
      color: #f9fafb;
    }
    .header button {
      padding: 8px 16px;
      background: #ef4444;
      color: white;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: background-color 0.2s;
      white-space: nowrap;
    }
    .header button:hover {
      background: #dc2626;
    }
    .editor-wrapper {
      flex: 1;
      position: relative;
      overflow: hidden;
      background: #ffffff;
      transition: background-color 0.2s;
    }
    body.dark .editor-wrapper {
      background: #111827;
    }
    #onlyoffice-editor-container {
      width: 100%;
      height: 100%;
    }
    .loading {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #6b7280;
      font-size: 14px;
      background: #ffffff;
      transition: background-color 0.2s, color 0.2s;
    }
    body.dark .loading {
      background: #111827;
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${file.name.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</h1>
    <button onclick="window.close()">Close</button>
  </div>
  <div class="editor-wrapper">
    <div id="onlyoffice-editor-container" class="loading">Loading editor...</div>
  </div>
  <script src="${onlyofficeJsUrl}"></script>
  <script>
    // Detect and apply dark mode based on system preference or stored preference
    function applyTheme() {
      const isDark = localStorage.theme === 'dark' || 
        (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
      }
    }
    applyTheme();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    
    const config = ${JSON.stringify(config)};
    new DocsAPI.DocEditor('onlyoffice-editor-container', config);
  </script>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Viewer page error');
    res.status(500).send('Error loading viewer');
  }
}

module.exports = {
  getViewerPage,
};
