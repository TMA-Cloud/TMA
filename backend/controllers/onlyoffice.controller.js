const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const jwt = require('jsonwebtoken');
const { resolveFilePath, isValidPath } = require('../utils/filePath');
const { getFile } = require('../models/file.model');
const { getUserById } = require('../models/user.model');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET;
// Backend URL that ONLYOFFICE Document Server can access to download files
// Only needed if ONLYOFFICE is in Docker/remote - if not set, will derive from request
const BACKEND_URL = process.env.BACKEND_URL;

if (!ONLYOFFICE_JWT_SECRET) {
  console.warn('ONLYOFFICE_JWT_SECRET not set; ONLYOFFICE integration will run without JWT.');
}

function getFileTypeFromName(name) {
  const ext = path.extname(name || '').toLowerCase().replace(/^\./, '');
  return ext || 'docx';
}

function buildSignedFileToken(fileId) {
  if (!ONLYOFFICE_JWT_SECRET) return null;
  return jwt.sign(
    { fileId },
    ONLYOFFICE_JWT_SECRET,
    { expiresIn: '10m' },
  );
}

async function getConfig(req, res) {
  try {
    const fileId = req.params.id;
    const userId = req.userId;
    
    // Fetch user info to get the name for ONLYOFFICE
    const user = await getUserById(userId);
    const userName = user?.name || user?.email || 'User';
    
    const file = await getFile(fileId, userId);
    if (!file) return res.status(404).json({ message: 'File not found' });

    const fileType = getFileTypeFromName(file.name);
    const viewOnly = fileType === 'pdf';

    const token = buildSignedFileToken(file.id);
    // Use BACKEND_URL if set (for Docker/remote ONLYOFFICE), otherwise derive from request
    // ONLYOFFICE Document Server needs this URL to download files
    const backendBaseUrl = BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${backendBaseUrl}/api/onlyoffice/file/${file.id}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
    const callbackUrl = `${backendBaseUrl}/api/onlyoffice/callback`;

    const config = {
      document: {
        fileType,
        key: `${file.id}-${Date.now()}`,
        title: file.name,
        url: downloadUrl,
      },
      editorConfig: {
        callbackUrl: callbackUrl,
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
      type: 'desktop',
    };

    let tokenForConfig = null;
    if (ONLYOFFICE_JWT_SECRET) {
      tokenForConfig = jwt.sign(config, ONLYOFFICE_JWT_SECRET);
    }

    res.json({ config, token: tokenForConfig });
  } catch (err) {
    console.error('[ONLYOFFICE] Config error:', err);
    res.status(500).json({ message: 'Server error' });
  }
}

async function serveFile(req, res) {
  try {
    const { id } = req.params;
    const token = req.query.t;

    // Add CORS headers for ONLYOFFICE server
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    // Validate token if JWT secret is configured
    if (ONLYOFFICE_JWT_SECRET) {
      if (!token) {
        console.error('[ONLYOFFICE] Missing token for file', id);
        return res.status(401).json({ error: 'Missing token' });
      }
      try {
        // Decode token (it's already URL encoded)
        const decodedToken = decodeURIComponent(String(token));
        const payload = jwt.verify(decodedToken, ONLYOFFICE_JWT_SECRET);
        if (payload.fileId !== id) {
          console.error('[ONLYOFFICE] Token fileId mismatch', { tokenFileId: payload.fileId, requestedId: id });
          return res.status(401).json({ error: 'Invalid token' });
        }
      } catch (e) {
        console.error('[ONLYOFFICE] Token verification failed', e.message);
        return res.status(401).json({ error: 'Invalid token' });
      }
    }

    // Fetch file path directly from DB by id
    const db = require('../config/db');
    const result = await db.query(
      'SELECT name, mime_type AS "mimeType", path FROM files WHERE id = $1',
      [id],
    );
    const fileRow = result.rows[0];
    if (!fileRow) {
      console.error('[ONLYOFFICE] File not found in DB', id);
      return res.status(404).json({ error: 'File not found' });
    }
    if (!fileRow.path || !isValidPath(fileRow.path)) {
      console.error('[ONLYOFFICE] File missing or invalid path', id);
      return res.status(404).json({ error: 'File missing or invalid path' });
    }
    
    // Resolve file path (handles both relative and absolute paths)
    let filePath;
    try {
      filePath = resolveFilePath(fileRow.path);
    } catch (err) {
      console.error('[ONLYOFFICE] Error resolving file path:', err.message);
      return res.status(404).json({ error: 'Invalid file path' });
    }

    if (!fs.existsSync(filePath)) {
      console.error('[ONLYOFFICE] File not found on disk', filePath);
      return res.status(404).json({ error: 'File not found on disk' });
    }

    // Set appropriate headers
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileRow.name)}"`);
    res.type(fileRow.mimeType || 'application/octet-stream');
    res.sendFile(filePath);
  } catch (err) {
    console.error('[ONLYOFFICE] Error serving file', err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function getViewerPage(req, res) {
  try {
    const fileId = req.params.id;
    const userId = req.userId;
    
    // Verify file access
    const file = await getFile(fileId, userId);
    if (!file) return res.status(404).send('File not found');

    // Get user name
    const user = await getUserById(userId);
    const userName = user?.name || user?.email || 'User';

    const fileType = getFileTypeFromName(file.name);
    const viewOnly = fileType === 'pdf';
    const token = buildSignedFileToken(file.id);
    const backendBaseUrl = BACKEND_URL || `${req.protocol}://${req.get('host')}`;
    const downloadUrl = `${backendBaseUrl}/api/onlyoffice/file/${file.id}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
    const callbackUrl = `${backendBaseUrl}/api/onlyoffice/callback`;
    const onlyofficeJsUrl = process.env.ONLYOFFICE_URL 
      ? `${process.env.ONLYOFFICE_URL}/web-apps/apps/api/documents/api.js`
      : 'http://localhost:2202/web-apps/apps/api/documents/api.js';

    const config = {
      document: {
        fileType,
        key: `${file.id}-${Date.now()}`,
        title: file.name,
        url: downloadUrl,
      },
      editorConfig: {
        callbackUrl: callbackUrl,
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
      type: 'desktop',
    };

    let configToken = null;
    if (ONLYOFFICE_JWT_SECRET) {
      configToken = jwt.sign(config, ONLYOFFICE_JWT_SECRET);
      if (configToken) config.token = configToken;
    }

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
    console.error('[ONLYOFFICE] Viewer page error:', err);
    res.status(500).send('Error loading viewer');
  }
}

/**
 * Download file from URL
 */
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    protocol.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download: ${response.statusCode}`));
        return;
      }
      
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract file ID from OnlyOffice document key
 * Key format: `${fileId}-${timestamp}`
 * Since file IDs are 16 characters and don't contain hyphens, we take everything before the last hyphen
 */
function extractFileIdFromKey(key) {
  if (!key) return null;
  const parts = key.split('-');
  if (parts.length < 2) return null;
  // File ID is everything except the last part (which is the timestamp)
  const fileIdPart = parts.slice(0, -1).join('-');
  return fileIdPart || null;
}

async function callback(req, res) {
  // Add CORS headers for ONLYOFFICE server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const body = req.body;

    // OnlyOffice callback statuses:
    // 0 = document is being edited
    // 2 = document is ready for saving
    // 3 = document saving error occurred
    // 4 = document is closed with no changes
    // 6 = document is being edited, but the current document state is saved
    const status = body.status;
    const shouldSave = status === 2 || status === 6;

    if (shouldSave && body.url) {
      const fileId = extractFileIdFromKey(body.key);
      
      if (!fileId) {
        console.error('[ONLYOFFICE] Could not extract file ID from key:', body.key);
        return res.status(200).json({ error: 0 }); // Still return success to OnlyOffice
      }

      // Get file info from database
      const db = require('../config/db');
      const fileResult = await db.query(
        'SELECT id, name, path, user_id FROM files WHERE id = $1',
        [fileId]
      );

      if (fileResult.rows.length === 0) {
        console.error('[ONLYOFFICE] File not found in database:', fileId);
        return res.status(200).json({ error: 0 });
      }

      const fileRow = fileResult.rows[0];
      
      // Only allow saving to files in UPLOAD_DIR (not custom drive files)
      // Custom drive files are read-only
      if (!fileRow.path || path.isAbsolute(fileRow.path)) {
        console.error('[ONLYOFFICE] Cannot save to custom drive file:', fileId);
        return res.status(200).json({ error: 0 }); // Still return success
      }
      
      const filePath = resolveFilePath(fileRow.path);

      // Download the updated document from OnlyOffice
      let fileBuffer;
      try {
        fileBuffer = await downloadFile(body.url);
      } catch (error) {
        console.error('[ONLYOFFICE] Failed to download document:', error);
        return res.status(200).json({ error: 0 }); // Still return success
      }

      // Save the downloaded file, replacing the existing one
      await fs.promises.writeFile(filePath, fileBuffer);

      // Update file size and modified timestamp in database
      const newSize = fileBuffer.length;
      await db.query(
        'UPDATE files SET size = $1, modified = NOW() WHERE id = $2',
        [newSize, fileId]
      );
    } else if (status === 3) {
      console.error('[ONLYOFFICE] Document saving error for:', body.key);
    }

    // Always return success to OnlyOffice
    res.status(200).json({ error: 0 });
  } catch (err) {
    console.error('[ONLYOFFICE] Callback error', err);
    // Still return success to OnlyOffice even on error
    // to prevent OnlyOffice from retrying
    res.status(200).json({ error: 0 });
  }
}

module.exports = {
  getConfig,
  serveFile,
  callback,
  getViewerPage,
};


