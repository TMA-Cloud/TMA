/**
 * Stream upload middleware for S3: parses multipart and pipes file stream
 * directly through encryption to S3 (no temp dir, minimal RAM).
 * Use only when STORAGE_DRIVER=s3.
 *
 * Content is checked against the file's extension from its first few KB.
 *
 * Because the rest of validation (parentId, permissions, file-name checks) runs
 * in the controller *after* the stream finishes, every successful S3 put is
 * tracked on `req._s3UploadedKeys`.  A one-time `res.on('finish', …)` listener
 * automatically deletes those objects when the response is an error (4xx/5xx)
 * and the controller hasn't already consumed them — preventing orphan files.
 */

import path from 'path';
import { pipeline } from 'stream/promises';

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

/** The tail of the message createMimeCheckStream rejects with. */
const MIME_REJECTION_MARKER = 'does not match extension';

/**
 * @param {Error} err
 * @returns {boolean} whether this is the magic-bytes check refusing the file
 */
function isMimeRejection(err) {
  return typeof err?.message === 'string' && err.message.includes(MIME_REJECTION_MARKER);
}

/**
 * Errors a stream raises because something else already broke.
 */
const SHRAPNEL_CODES = new Set(['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR']);

/**
 * @param {Error} err
 * @returns {boolean} whether this error is the wreckage of an earlier failure
 */
function isShrapnel(err) {
  return SHRAPNEL_CODES.has(err?.code);
}

/** Storage refusing the object is ours to own, not the client's to fix. */
const STORAGE_UNAVAILABLE = 'Storage is temporarily unavailable. Please try again.';

/**
 * @param {Error} err
 * @returns {boolean} whether the storage backend, not the request, is at fault
 */
function isStorageFault(err) {
  return err?.$fault === 'server' || err?.$metadata?.httpStatusCode >= 500;
}

/**
 * Turns a stream error into something worth showing the user.
 * @param {Error} err
 * @returns {string}
 */
function describeFailure(err) {
  // The backend's own words name its internals ("The service is unavailable").
  if (isStorageFault(err)) return STORAGE_UNAVAILABLE;
  const message = err?.message;
  if (!message || isShrapnel(err)) return 'Upload failed';
  return message;
}

/**
 * Maps a rejection reason to the status that describes it. A refused file is
 * the client's problem to fix but storage being down is not.
 * @param {string} reason
 * @returns {number}
 */
function uploadFailureStatus(reason) {
  if (reason.includes(MIME_REJECTION_MARKER)) return 415;
  if (reason.includes('File too large')) return 413;
  if (reason === STORAGE_UNAVAILABLE) return 503;
  return 400;
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
        // Why individual files were rejected, so the response can name them
        // instead of failing silently. Each carries the ordinal of its own file
        // part, which is what ties it back to the metadata the client sent
        // alongside it.
        const fileFailures = [];
        let fileCount = 0;
        let finished = false;
        let hadError = false;
        let pending = 0;
        let fileIndex = 0;

        // Set once the client hangs up, which is the point after which there is
        // no one to answer and nothing worth recording.
        let clientGone = false;

        // Busboy can still error after the last part settled; only the first
        // outcome may hand control on.
        let handedOff = false;
        const handOff = err => {
          if (handedOff || clientGone) return;
          handedOff = true;
          next(err);
        };

        /**
         * Responds immediately (415) on failed magic-byte checks for single uploads.
         * Closes the socket without draining the remaining body, aborting the client's
         * transfer early to save bandwidth.
         */
        let stoppedEarly = false;
        const rejectWithoutReadingRest = reason => {
          if (stoppedEarly) return;
          stoppedEarly = true;
          req.unpipe(busboy);
          busboy.destroy();
          req.body = fields;
          req.streamedUpload = null;
          req.streamedUploadFailures = fileFailures;
          const err = new Error(reason);
          err.status = uploadFailureStatus(reason);
          handOff(err);
        };

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

          let failed = false;

          /**
           * Records why this file was rejected and unwinds its streams.
           *
           * Nothing downstream ends on its own when a transform is destroyed, so
           * without this the S3 put would wait forever on a stream that will never
           * end and the request would never answer. Draining the part keeps busboy
           * moving on to the remaining files.
           */
          const failFile = (err, message, level = 'warn') => {
            if (failed || clientGone) return;
            failed = true;
            hadError = true;
            const reason = describeFailure(err);
            fileFailures.push({ fileName: filename, error: reason, index: currentIndex });
            logger[level]({ err, storageName, filename }, message);
            if (!mimeCheckStream.destroyed) mimeCheckStream.destroy(err);
            fileStream.unpipe(mimeCheckStream);
            fileStream.resume();
            if (singleOrBulk === 'single') rejectWithoutReadingRest(reason);
          };

          let totalBytes = 0;
          fileStream.on('data', chunk => {
            totalBytes += chunk.length;
            if (totalBytes > maxFileSize) {
              failFile(new Error('File too large'), '[StreamUpload] File exceeds the maximum upload size');
            }
          });

          // Set when the chain down without a reason of its own, so the put
          // which is holding the real one gets to speak first.
          let shrapnel = null;

          fileStream.pipe(mimeCheckStream);
          // pipeline (not pipe) so a rejected file tears the whole chain down and
          // the S3 put rejects instead of hanging on a stream that stopped early.
          const chainSettled = pipeline(mimeCheckStream, counterStream, encryptStream).catch(err => {
            // When the destination dies it destroys the body it was reading, and
            // the chain reports that teardown as an abort. Racing to record it
            // would bury the storage error behind "The operation was aborted"
            // and answer 400 for an outage so the put settles a tick later and
            // knows what actually happened.
            if (isShrapnel(err)) {
              shrapnel = err;
              return;
            }
            failFile(
              err,
              isMimeRejection(err) ? '[StreamUpload] MIME validation failed' : '[StreamUpload] Upload stream failed'
            );
          });

          fileStream.on('error', err => failFile(err, '[StreamUpload] File stream error'));

          // Both outcomes as values, so the verdict below waits for each. A put
          // can report success before the chain's abort has surfaced, and
          // judging on whichever landed first is how a truncated file gets
          // written to the database as a whole one.
          const putSettled = storage.putStream(storageName, encryptStream).then(
            () => null,
            err => err
          );

          Promise.all([putSettled, chainSettled])
            .then(([putError]) => {
              if (clientGone) {
                // No row will be written for a request nobody is waiting on, so
                // anything that did reach storage is already an orphan.
                if (!putError) cleanupS3Keys([storageName]);
                return;
              }
              if (putError) {
                // A file we already rejected drags the put down with it, and
                // failFile keeps the first reason.
                failFile(putError, '[StreamUpload] Upload failed', 'error');
                return;
              }
              if (failed || shrapnel) {
                // Either the put beat the rejection to the finish line, or it
                // called a body that stopped early a success. Neither is a file
                // worth keeping, and an object left behind for one is an orphan.
                cleanupS3Keys([storageName]);
                if (shrapnel) failFile(shrapnel, '[StreamUpload] Upload stream ended early');
                return;
              }
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
            .finally(() => {
              pending -= 1;
              checkDone();
            });
        });

        // A cancelled upload is not a failure to report.
        req.on('aborted', () => {
          if (clientGone) return;
          clientGone = true;
          logger.info('[StreamUpload] Upload cancelled by the client');

          // The response will never finish, so the listener that normally sweeps
          // these never runs. Whatever already reached storage has no request
          // left to claim it.
          if (req._s3UploadedKeys?.length > 0) {
            cleanupS3Keys(req._s3UploadedKeys);
            req._s3UploadedKeys = [];
          }

          try {
            busboy.destroy(new Error('Request aborted'));
          } catch {
            // ignore destroy errors
          }
        });

        function checkDone() {
          if (finished && pending === 0) {
            req.body = fields;
            // The controller folds these into its own per-file failure list so the
            // client learns which files were rejected and why.
            req.streamedUploadFailures = fileFailures;
            if (singleOrBulk === 'single') {
              const first = uploadsByIndex.find(Boolean) || null;
              req.streamedUpload = first;
              if (first && !hadError) {
                handOff();
                return;
              }
              const reason = fileFailures[0]?.error || (hadError ? 'Upload failed' : 'No file uploaded');
              const err = new Error(reason);
              err.status = uploadFailureStatus(reason);
              handOff(err);
            } else {
              const uploads = uploadsByIndex.filter(Boolean);
              req.streamedUploads = uploads;
              handOff();
            }
          }
        }

        busboy.on('finish', () => {
          finished = true;
          if (fileCount === 0) {
            req.body = fields;
            req.streamedUpload = null;
            req.streamedUploads = [];
            handOff();
          } else {
            checkDone();
          }
        });

        busboy.on('error', err => {
          // This is the parser noticing the body stopped mid-part,
          // which is what cancelling looks like from here.
          if (clientGone) return;
          logger.error({ err }, '[StreamUpload] Busboy error');
          handOff(err);
        });

        req.pipe(busboy);
      })
      .catch(err => next(err));
  };
}

export { streamUploadToS3 };
