/**
 * Stream upload middleware for S3: parses multipart and pipes file stream
 * directly through encryption to S3 (no temp dir, minimal RAM).
 * Use only when STORAGE_DRIVER=s3.
 *
 * Because validation (parentId, permissions, file-name checks) runs in the
 * controller *after* the stream finishes, every successful S3 put is tracked
 * on `req._s3UploadedKeys`.  A one-time `res.on('finish', …)` listener
 * automatically deletes those objects when the response is an error (4xx/5xx)
 * and the controller hasn't already consumed them — preventing orphan files.
 */

import path from 'path';

import Busboy from 'busboy';

import { logger } from '../config/logger.js';
import { getMaxUploadSizeSettings } from '../models/user.model.js';
import { createByteCountStream, createEncryptStream } from '../utils/fileEncryption.js';
import { generateId } from '../utils/id.js';
import { createMimeCheckStream } from '../utils/mimeTypeDetection.js';
import storage from '../utils/storageDriver.js';

/**
 * Delete a list of S3 objects, logging (but not throwing on) individual failures.
 * @param {string[]} keys - S3 storage keys to remove
 */
function cleanupS3Keys(keys) {
  for (const key of keys) {
    storage.deleteObject(key).catch(err => {
      logger.warn({ err, storageName: key }, '[StreamUpload] Failed to clean up orphaned S3 object');
    });
  }
}

/**
 * Single file: stream one file to S3, set req.streamedUpload and req.body (parentId etc).
 * Bulk: stream each file to S3, set req.streamedUploads (array) and req.body.
 */
function streamUploadToS3(singleOrBulk = 'single') {
  return (req, res, next) => {
    getMaxUploadSizeSettings()
      .then(settings => {
        const maxFileSize = settings.maxBytes;

        const contentType = req.headers['content-type'] || '';
        if (!contentType.includes('multipart/form-data')) {
          return next(new Error('Expected multipart/form-data'));
        }

        const busboy = Busboy({
          headers: { 'content-type': contentType },
          defParamCharset: 'utf8',
        });
        const fields = {};
        // Keep uploads in original multipart order (by file part order).
        // We store each upload at its fileIndex to avoid reordering caused by async S3 uploads finishing out of order.
        const uploadsByIndex = [];
        let fileCount = 0;
        let finished = false;
        let hadError = false;
        let pending = 0;
        let fileIndex = 0;

        // Track every S3 key we successfully PUT so we can delete them if the
        // controller later rejects the request (bad parentId, invalid name, etc.).
        if (!req._s3UploadedKeys) {
          req._s3UploadedKeys = [];

          // Auto-cleanup: when the response finishes with an error status and the
          // controller hasn't explicitly marked the uploads as consumed, delete them.
          res.on('finish', () => {
            if (res.statusCode >= 400 && req._s3UploadedKeys.length > 0) {
              logger.info(
                { keys: req._s3UploadedKeys, statusCode: res.statusCode },
                '[StreamUpload] Response was an error — cleaning up orphaned S3 objects'
              );
              cleanupS3Keys(req._s3UploadedKeys);
              req._s3UploadedKeys = [];
            }
          });
        }

        busboy.on('field', (name, value) => {
          // Support repeated fields (e.g. relativePaths, clientIds) by collecting into arrays.
          if (Object.prototype.hasOwnProperty.call(fields, name)) {
            const existing = fields[name];
            if (Array.isArray(existing)) {
              existing.push(value);
            } else {
              fields[name] = [existing, value];
            }
          } else {
            fields[name] = value;
          }
        });

        busboy.on('file', (fieldname, fileStream, info) => {
          const { filename, mimeType } = info;
          if (!filename || filename === '') {
            fileStream.resume();
            return;
          }
          if (fieldname !== 'file' && fieldname !== 'files') {
            fileStream.resume();
            return;
          }

          fileCount += 1;
          pending += 1;
          const currentIndex = fileIndex;
          fileIndex += 1;
          const id = generateId(16);
          const ext = path.extname(filename);
          const storageName = id + ext;

          const mimeCheckStream = createMimeCheckStream(filename);
          const { stream: counterStream, getByteCount } = createByteCountStream();
          const encryptStream = createEncryptStream();

          let totalBytes = 0;
          fileStream.on('data', chunk => {
            totalBytes += chunk.length;
            if (totalBytes > maxFileSize) {
              fileStream.destroy(new Error('File too large'));
            }
          });

          fileStream.pipe(mimeCheckStream).pipe(counterStream).pipe(encryptStream);

          mimeCheckStream.on('error', err => {
            hadError = true;
            logger.warn({ err, storageName, filename }, '[StreamUpload] MIME validation failed');
          });

          storage
            .putStream(storageName, encryptStream)
            .then(() => {
              const size = getByteCount();
              // Track for automatic orphan cleanup on controller rejection.
              req._s3UploadedKeys.push(storageName);
              uploadsByIndex[currentIndex] = {
                id,
                storageName,
                name: filename,
                size,
                mimeType: mimeType || 'application/octet-stream',
                index: currentIndex,
              };
            })
            .catch(err => {
              hadError = true;
              logger.error({ err, storageName }, '[StreamUpload] Upload failed');
            })
            .finally(() => {
              pending -= 1;
              checkDone();
            });

          fileStream.on('error', err => {
            hadError = true;
            logger.error({ err, storageName }, '[StreamUpload] File stream error');
          });
          encryptStream.on('error', err => {
            hadError = true;
            logger.error({ err, storageName }, '[StreamUpload] Encrypt stream error');
          });
        });

        // If the client aborts the request, stop processing further and let existing streams unwind.
        req.on('aborted', () => {
          logger.warn('[StreamUpload] Request aborted by client');
          try {
            busboy.destroy(new Error('Request aborted'));
          } catch {
            // ignore destroy errors
          }
        });

        function checkDone() {
          if (finished && pending === 0) {
            req.body = fields;
            if (singleOrBulk === 'single') {
              const first = uploadsByIndex.find(Boolean) || null;
              req.streamedUpload = first;
              next(hadError || !first ? new Error(hadError ? 'Upload failed' : 'No file uploaded') : null);
            } else {
              const uploads = uploadsByIndex.filter(Boolean);
              req.streamedUploads = uploads;
              next(uploads.length === 0 ? new Error('All uploads failed') : null);
            }
          }
        }

        busboy.on('finish', () => {
          finished = true;
          if (fileCount === 0) {
            req.body = fields;
            req.streamedUpload = null;
            req.streamedUploads = [];
            next();
          } else {
            checkDone();
          }
        });

        busboy.on('error', err => {
          logger.error({ err }, '[StreamUpload] Busboy error');
          next(err);
        });

        req.pipe(busboy);
      })
      .catch(err => next(err));
  };
}

export { streamUploadToS3 };
