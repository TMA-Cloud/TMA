import http from 'http';
import https from 'https';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

import db from '../../config/db.js';
import { logger } from '../../config/logger.js';
import { logAuditEvent } from '../../services/auditLogger.js';
import { unregisterOpenDocument } from '../../services/onlyofficeAutoSave.js';
import { EventTypes, publishFileEvent } from '../../services/fileEvents.js';
import storage from '../../utils/storageDriver.js';
import {
  invalidateFileCache,
  invalidateSearchCache,
  cacheKeys,
  deleteCache,
  deleteCachePattern,
} from '../../utils/cache.js';
import { createEncryptStream, newWrappedDek } from '../../utils/fileEncryption.js';
import { generateId } from '../../utils/id.js';
import { validateId } from '../../utils/validation.js';

import { getOnlyOfficeConfig, verifyCallbackToken } from './onlyoffice.utils.js';

/**
 * Download file from URL
 */
function downloadFileStream(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    protocol
      .get(url, response => {
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: ${response.statusCode}`));
          return;
        }

        resolve(response);
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
    // SECURITY: authenticate the callback via the OnlyOffice JWT and use the
    // verified payload (not raw req.body) as the source of truth.
    const onlyOfficeConfig = await getOnlyOfficeConfig();
    if (!onlyOfficeConfig.jwtSecret) {
      logger.error('[ONLYOFFICE] Callback rejected - OnlyOffice JWT secret not configured');
      return res.status(401).json({ error: 1 });
    }

    const body = verifyCallbackToken(req, onlyOfficeConfig.jwtSecret);
    if (!body) {
      logger.warn('[ONLYOFFICE] Callback rejected - missing or invalid JWT signature');
      return res.status(401).json({ error: 1 });
    }

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
      await unregisterOpenDocument(body.key);
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

        // Allow the configured ONLYOFFICE host (reuse config from top of handler)
        let isTrustedOnlyofficeHost = false;
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
      const fileResult = await db.query(
        `SELECT f.id, f.name, f.path, f.user_id, f.parent_id, f.size,
                u.storage_used, u.storage_reserved, u.storage_limit
           FROM files f
           JOIN users u ON u.id = f.user_id
          WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NULL`,
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

      // Check the stored object key
      if (!fileRow.path) {
        logger.error('[ONLYOFFICE] File has no path:', validatedFileId);
        return res.status(200).json({ error: 0 });
      }

      let sourceStream;
      try {
        sourceStream = await downloadFileStream(body.url);
      } catch (error) {
        logger.error('[ONLYOFFICE] Failed to download document:', error);
        return res.status(200).json({ error: 0 });
      }

      // Re-keys the body under a fresh DEK. Persist the wrapped DEK alongside the object metadata.
      const dekInfo = newWrappedDek();

      const encryptStream = createEncryptStream(dekInfo.dek);
      let newSize = 0;
      const limit = fileRow.storage_limit == null ? null : Number(fileRow.storage_limit);
      const maximumReplacementSize =
        limit == null
          ? Number.POSITIVE_INFINITY
          : Math.max(
              0,
              limit -
                Number(fileRow.storage_used || 0) -
                Number(fileRow.storage_reserved || 0) +
                Number(fileRow.size || 0)
            );
      const byteCounter = new Transform({
        transform(chunk, _encoding, callback) {
          newSize += chunk.length;
          if (newSize > maximumReplacementSize) {
            const error = new Error('Storage limit exceeded');
            error.code = 'STORAGE_LIMIT_EXCEEDED';
            callback(error);
            return;
          }
          callback(null, chunk);
        },
      });
      const temporaryPath = `${generateId(16)}${path.extname(fileRow.name)}`;
      try {
        const uploadPromise = storage.putStream(temporaryPath, encryptStream);
        await Promise.all([pipeline(sourceStream, byteCounter, encryptStream), uploadPromise]);
      } catch (error) {
        await storage.deleteObject(temporaryPath).catch(() => undefined);
        if (error.code === 'STORAGE_LIMIT_EXCEEDED') {
          logger.warn(
            { fileId: validatedFileId },
            '[ONLYOFFICE] Save rejected because storage quota would be exceeded'
          );
          return res.status(200).json({ error: 1 });
        }
        throw error;
      }

      // Atomically point metadata at the completed temporary object only after
      // rechecking quota under the same user-row lock used by normal uploads.
      const client = await db.connect();
      let replacedPath;
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT f.path, f.size, u.storage_used, u.storage_reserved, u.storage_limit
             FROM files f
             JOIN users u ON u.id = f.user_id
            WHERE f.id = $1 AND f.user_id = $2 AND f.deleted_at IS NULL
            FOR UPDATE OF f, u`,
          [validatedFileId, validatedUserId]
        );
        if (locked.rows.length === 0) throw new Error('File no longer exists');
        const current = locked.rows[0];
        const currentLimit = current.storage_limit == null ? null : Number(current.storage_limit);
        const projected =
          Number(current.storage_used || 0) +
          Number(current.storage_reserved || 0) -
          Number(current.size || 0) +
          newSize;
        if (currentLimit !== null && projected > currentLimit) {
          const error = new Error('Storage limit exceeded');
          error.code = 'STORAGE_LIMIT_EXCEEDED';
          throw error;
        }
        replacedPath = current.path;
        await client.query(
          `UPDATE files
              SET path = $1, size = $2, modified = NOW(), dek_wrapped = $3, dek_kek_version = $4
            WHERE id = $5 AND user_id = $6`,
          [temporaryPath, newSize, dekInfo.dekWrapped, dekInfo.kekVersion, validatedFileId, validatedUserId]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        await storage.deleteObject(temporaryPath).catch(() => undefined);
        if (error.code === 'STORAGE_LIMIT_EXCEEDED') {
          logger.warn({ fileId: validatedFileId }, '[ONLYOFFICE] Concurrent save rejected by storage quota');
          return res.status(200).json({ error: 1 });
        }
        throw error;
      } finally {
        client.release();
      }
      if (replacedPath && replacedPath !== temporaryPath) {
        await storage.deleteObject(replacedPath).catch(error => {
          logger.warn({ err: error, replacedPath }, '[ONLYOFFICE] Could not remove superseded document object');
        });
      }

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

      // Attach userId to req so audit logger can pick it up
      req.userId = validatedUserId;

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

export { callback };
