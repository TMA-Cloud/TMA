import { logger } from '../../config/logger.js';
import { getFile } from '../../models/file.model.js';
import { recordAccess } from '../../services/accessTracker.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { registerOpenDocument } from '../../services/onlyofficeAutoSave.js';
import { validateSingleId } from '../../utils/controllerHelpers.js';
import { validateAndResolveFile } from '../../utils/fileDownload.js';
import { validateOnlyOfficeMimeType } from '../../utils/mimeTypeDetection.js';

import { buildEditorSession, getOnlyOfficeConfig, validateFileForOnlyOffice } from './onlyoffice.utils.js';

/**
 * Get standalone viewer HTML page for document editing/viewing
 */
async function getViewerPage(req, res) {
  try {
    // SECURITY: Require both JWT secret and URL for OnlyOffice integration
    const onlyOfficeConfig = await getOnlyOfficeConfig();
    if (!onlyOfficeConfig.jwtSecret || !onlyOfficeConfig.url) {
      return res.status(424).send('OnlyOffice integration not configured. Configure it in Settings.');
    }

    const { valid, id: fileId, error } = validateSingleId(req);
    if (!valid) {
      return res.status(400).send(error);
    }
    // Files belong to the account owner; a sub-user edits the owner's copy.
    const userId = req.ownerId;

    const file = await getFile(fileId, userId);
    const validation = await validateFileForOnlyOffice(file, validateAndResolveFile, validateOnlyOfficeMimeType);

    if (!validation.valid) {
      if (!file) {
        return res.status(404).send(validation.error);
      }
      logger.warn({ fileId, fileName: file.name, error: validation.error }, '[ONLYOFFICE] Validation failed');

      // Check if request is from fetch/XHR (for modal) or direct browser access (new tab)
      const acceptsJson = req.headers.accept?.includes('application/json');
      const isXhr = req.headers['x-requested-with'] === 'XMLHttpRequest';

      if (acceptsJson || isXhr) {
        return res.status(400).json({
          message: validation.error,
          error: 'MIME_TYPE_MISMATCH',
        });
      }

      // For direct browser access (new tab), return simple HTML error page
      return res.status(400).send(`
        <!DOCTYPE html>
        <html>
        <head><title>Error</title></head>
        <body style="font-family: sans-serif; padding: 40px; text-align: center;">
          <h1 style="color: #dc2626;">Cannot Open File</h1>
          <p>${file.name.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
          <p style="color: #6b7280;">${validation.error.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>
          <button onclick="window.close()" style="padding: 10px 20px; background: #3b82f6; color: white; border: none; border-radius: 6px; cursor: pointer;">Close</button>
        </body>
        </html>
      `);
    }

    const { config, configToken, onlyofficeJsUrl } = await buildEditorSession(req, file, userId);

    // Register document for auto-save
    registerOpenDocument(config.document.key, file.id, userId);

    // Opening the viewer is the read; the document server's later fetches of
    // /onlyoffice/file all stem from this one action.
    recordAccess(file.id, userId);

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
      background: #1b1b19;
    }
    .header {
      background: #f9f9f7;
      border-bottom: 1px solid #e7e6e1;
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
      background: #2c2c28;
      border-bottom-color: #4a4944;
    }
    .header h1 {
      font-size: 18px;
      font-weight: 600;
      color: #1b1b19;
      flex: 1;
      margin-right: 16px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      transition: color 0.2s;
    }
    body.dark .header h1 {
      color: #f3f3f0;
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
      background: #1b1b19;
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
      color: #66645d;
      font-size: 14px;
      background: #ffffff;
      transition: background-color 0.2s, color 0.2s;
    }
    body.dark .loading {
      background: #1b1b19;
      color: #b0aea6;
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
    // The app hands its theme over in the ?theme= query param. This tab is often
    // a different origin than the app, so localStorage.theme isn't shared here so
    // the query param is the authoritative signal, with localStorage/OS as a
    // fallback only for stale links that lack it.
    var appTheme = ${JSON.stringify(req.query?.theme === 'dark' || req.query?.theme === 'light' ? req.query.theme : null)};
    function applyTheme() {
      var isDark = appTheme
        ? appTheme === 'dark'
        : localStorage.theme === 'dark' ||
          (!('theme' in localStorage) && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) {
        document.body.classList.add('dark');
      } else {
        document.body.classList.remove('dark');
      }
    }
    applyTheme();
    // Only track the OS preference when the app didn't pin a theme.
    if (!appTheme) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
    }

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

export { getViewerPage };
