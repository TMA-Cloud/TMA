const fs = require('fs');
const http = require('http');
const https = require('https');
const { Readable } = require('stream');
const { validateId } = require('../../utils/validation');
const { resolveFilePath } = require('../../utils/filePath');
const { logger } = require('../../config/logger');
const storage = require('../../utils/storageDriver');
const { createEncryptStream } = require('../../utils/fileEncryption');
const { logAuditEvent } = require('../../services/auditLogger');
const { getOnlyOfficeConfig } = require('./onlyoffice.utils');
const {
  invalidateFileCache,
  deleteCache,
  deleteCachePattern,
  cacheKeys,
  invalidateSearchCache,
} = require('../../utils/cache');
const { publishFileEvent, EventTypes } = require('../../services/fileEvents');
const { unregisterOpenDocument } = require('../../services/onlyofficeAutoSave');

/**
 * Download file from URL
 */
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    protocol
      .get(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => resolve(Buffer.concat(chunks)));
        response.on('error', reject);
      })
      .on('error', reject);
  });
}

/**
 * Extract userId and fileId from OnlyOffice document key (per-user encryption context).
 * Key format: `${userId}-${fileId}-${timestamp}` (IDs are alphanumeric, no hyphens)
 */
function parseDocumentKey(key) {
  if (!key || typeof key !== 'string') return null;
  const parts = key.split('-');
  if (parts.length < 3) return null;
  const userId = parts[0];
  const fileId = parts.slice(1, -1).join('-');
  const timestamp = parts[parts.length - 1];
  if (!userId || !fileId || !timestamp) return null;
  return { userId, fileId };
}

/**
 * Handle ONLYOFFICE callback for document saves
 */
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
    // 2 = document is ready for saving (closed)
    // 3 = document saving error occurred
    // 4 = document is closed with no changes
    // 6 = document is being edited, but the current document state is saved
    const status = body.status;
    const forcesavetype = body.forcesavetype; // 0=command, 1=button, 2=timer(autoAssembly), 3=form
    const shouldSave = status === 2 || status === 6;

    // Handle document close (status 2 or 4) - unregister from auto-save
    if (status === 2 || status === 4) {
      unregisterOpenDocument(body.key);
      logger.debug({ status, key: body.key }, '[ONLYOFFICE] Document closed, unregistered from auto-save');
    }

    // Log callback for debugging
    if (status === 6) {
      logger.info(
        {
          status,
          forcesavetype,
          key: body.key,
          forcesaveType:
            forcesavetype === 2
              ? 'autoAssembly (timer)'
              : forcesavetype === 1
                ? 'button'
                : forcesavetype === 0
                  ? 'command'
                  : 'unknown',
        },
        '[ONLYOFFICE] Status 6 callback received'
      );
    }

    if (shouldSave && body.url) {
      const parsed = parseDocumentKey(body.key);

      if (!parsed) {
        logger.error('[ONLYOFFICE] Could not parse document key (expected userId-fileId-timestamp):', body.key);
        return res.status(200).json({ error: 0 }); // Still return success to OnlyOffice
      }

      const { userId: keyUserId, fileId } = parsed;

      // Validate file ID and user ID format
      const validatedFileId = validateId(fileId);
      const validatedUserId = validateId(keyUserId);
      if (!validatedFileId || !validatedUserId) {
        logger.error('[ONLYOFFICE] Invalid file ID or user ID in key:', { fileId, userId: keyUserId });
        return res.status(200).json({ error: 0 });
      }

      // Validate URL to prevent SSRF - only allow http/https and check for localhost/internal IPs
      if (typeof body.url !== 'string' || (!body.url.startsWith('http://') && !body.url.startsWith('https://'))) {
        logger.error('[ONLYOFFICE] Invalid URL format:', body.url);
        return res.status(200).json({ error: 0 });
      }

      // Additional SSRF protection: block localhost and private IP ranges,
      // but allow the configured ONLYOFFICE server host/IP.
      try {
        const urlObj = new URL(body.url);
        const hostname = urlObj.hostname.toLowerCase();

        // If this callback comes from our configured ONLYOFFICE server, allow it
        let isTrustedOnlyofficeHost = false;
        const onlyOfficeConfig = await getOnlyOfficeConfig();
        if (onlyOfficeConfig.url) {
          try {
            const allowedOnlyofficeHost = new URL(onlyOfficeConfig.url).hostname.toLowerCase();
            if (hostname === allowedOnlyofficeHost) {
              isTrustedOnlyofficeHost = true;
            }
          } catch {
            // If OnlyOffice URL is misconfigured, fall through to normal checks
          }
        }

        // Block localhost variations (IPv4, IPv6, domain)
        const localhostPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '::1', '::', '[::1]', '[::ffff:127.0.0.1]'];

        // Block private IPv4 ranges
        const privateIPv4Patterns = [
          /^10\./, // 10.0.0.0/8
          /^192\.168\./, // 192.168.0.0/16
          /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
          /^169\.254\./, // 169.254.0.0/16 (link-local)
        ];

        // Block private IPv6 ranges
        const privateIPv6Patterns = [
          /^fe80:/i, // fe80::/10 (link-local)
          /^fc00:/i, // fc00::/7 (unique local)
          /^fd00:/i, // fd00::/8 (unique local)
          /^::ffff:127\./i, // IPv4-mapped localhost
          /^::ffff:10\./i, // IPv4-mapped 10.0.0.0/8
          /^::ffff:192\.168\./i, // IPv4-mapped 192.168.0.0/16
          /^::ffff:169\.254\./i, // IPv4-mapped link-local
        ];

        // Skip local/private checks for trusted ONLYOFFICE host
        if (!isTrustedOnlyofficeHost) {
          // Check localhost patterns
          if (localhostPatterns.includes(hostname)) {
            logger.error('[ONLYOFFICE] Blocked SSRF attempt to localhost:', hostname);
            return res.status(200).json({ error: 0 });
          }

          // Check private IPv4 ranges
          for (const pattern of privateIPv4Patterns) {
            if (pattern.test(hostname)) {
              logger.error('[ONLYOFFICE] Blocked SSRF attempt to private IP:', hostname);
              return res.status(200).json({ error: 0 });
            }
          }

          // Check private IPv6 ranges
          for (const pattern of privateIPv6Patterns) {
            if (pattern.test(hostname)) {
              logger.error('[ONLYOFFICE] Blocked SSRF attempt to private IPv6:', hostname);
              return res.status(200).json({ error: 0 });
            }
          }
        }
      } catch (urlError) {
        logger.error('[ONLYOFFICE] Invalid URL:', urlError);
        return res.status(200).json({ error: 0 });
      }

      // Strict DB permission: only accept callback when file belongs to user in key (User A cannot overwrite User B's file)
      const db = require('../../config/db');
      const fileResult = await db.query(
        'SELECT id, name, path, user_id, parent_id, size FROM files WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
        [validatedFileId, validatedUserId]
      );

      if (fileResult.rows.length === 0) {
        logger.error('[ONLYOFFICE] File not found or access denied (key user does not own file):', {
          fileId: validatedFileId,
          userId: validatedUserId,
        });
        return res.status(200).json({ error: 0 });
      }

      const fileRow = fileResult.rows[0];

      // Resolve file path (relative to UPLOAD_DIR)
      if (!fileRow.path) {
        logger.error('[ONLYOFFICE] File has no path:', validatedFileId);
        return res.status(200).json({ error: 0 });
      }

      let fileBuffer;
      try {
        fileBuffer = await downloadFile(body.url);
      } catch (error) {
        logger.error('[ONLYOFFICE] Failed to download document:', error);
        return res.status(200).json({ error: 0 });
      }

      const { isFilePathEncrypted } = require('../../utils/filePath');
      const { encryptFile } = require('../../utils/fileEncryption');
      const { safeUnlink } = require('../../utils/fileCleanup');

      if (storage.useS3()) {
        const plainStream = Readable.from(fileBuffer);
        const encryptStream = createEncryptStream();
        plainStream.pipe(encryptStream);
        await storage.putStream(fileRow.path, encryptStream);
      } else {
        const filePath = resolveFilePath(fileRow.path);
        if (isFilePathEncrypted(fileRow.path)) {
          const tempPath = filePath + '.tmp';
          await fs.promises.writeFile(tempPath, fileBuffer);
          try {
            await encryptFile(tempPath, filePath);
          } catch (error) {
            logger.error('[ONLYOFFICE] Error encrypting file after save:', error);
            await safeUnlink(tempPath);
            throw error;
          }
        } else {
          await fs.promises.writeFile(filePath, fileBuffer);
        }
      }

      // Update file size and modified timestamp in database
      const newSize = fileBuffer.length;
      await db.query('UPDATE files SET size = $1, modified = NOW() WHERE id = $2', [newSize, validatedFileId]);

      // Invalidate cache to ensure frontend sees updated file immediately
      const userId = fileRow.user_id;
      const parentId = fileRow.parent_id;

      // Invalidate file listing cache for the parent folder (and root if needed)
      await invalidateFileCache(userId, parentId);

      // Invalidate single file cache
      await deleteCache(cacheKeys.file(validatedFileId, userId));

      // Invalidate file stats cache (size changed)
      await deleteCache(cacheKeys.fileStats(userId));
      await deleteCache(cacheKeys.userStorage(userId)); // Invalidate storage usage cache

      // Invalidate search cache (modified date changed, affects search results)
      await invalidateSearchCache(userId);

      // Invalidate starred/shared caches if the file might be in those views
      // (Use pattern-based deletion to invalidate all sort orders)
      await deleteCachePattern(`files:${userId}:starred:*`);
      await deleteCachePattern(`files:${userId}:shared:*`);

      // Publish file updated event to notify frontend in real-time
      await publishFileEvent(EventTypes.FILE_UPDATED, {
        id: validatedFileId,
        name: fileRow.name,
        size: newSize,
        parentId,
        userId,
      });

      // Log audit event for document save
      await logAuditEvent(
        'document.save',
        {
          status: 'success',
          resourceType: 'file',
          resourceId: validatedFileId,
          metadata: {
            fileName: fileRow.name,
            fileSize: newSize,
            oldSize: fileRow.size || 0,
            savedVia: 'onlyoffice',
          },
        },
        req
      );

      logger.info(
        { fileId: validatedFileId, fileName: fileRow.name, newSize, oldSize: fileRow.size },
        'Document saved via ONLYOFFICE'
      );
    } else if (status === 3) {
      logger.error('[ONLYOFFICE] Document saving error for:', body.key);
    }

    // Always return success to OnlyOffice (required to prevent timeout and retries)
    res.status(200).json({ error: 0 });
  } catch (err) {
    logger.error({ err }, '[ONLYOFFICE] Callback error');
    // Still return success to OnlyOffice even on error to prevent retries
    res.status(200).json({ error: 0 });
  }
}

module.exports = {
  callback,
};
