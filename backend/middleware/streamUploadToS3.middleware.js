/**
 * Stream upload middleware for S3 (STORAGE_DRIVER=s3 only): parses multipart and
 * pipes each file through encryption to S3 with no temp dir and minimal RAM. The
 * stored MIME type is sniffed from the content, not the client header; this never
 * blocks. Since the rest of validation runs in the controller after the stream
 * finishes, every successful put is tracked on `req._s3UploadedKeys` and a
 * `res.on('finish')` listener deletes them on an error response, avoiding orphans.
 */

import path from 'path';
import { pipeline } from 'stream/promises';

import Busboy from 'busboy';

import { logger } from '../config/logger.js';
import { getMaxUploadSizeSettings } from '../models/user.model.js';
import { createByteCountStream, createEncryptStream } from '../utils/fileEncryption.js';
import { generateId } from '../utils/id.js';
import { createMimeSniffStream } from '../utils/mimeTypeDetection.js';
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
        // Stored by fileIndex so async puts finishing out of order don't reorder.
        const uploadsByIndex = [];
        // Per-file rejections (with their part ordinal) so the response can name them.
        const fileFailures = [];
        let fileCount = 0;
        let finished = false;
        let hadError = false;
        let pending = 0;
        let fileIndex = 0;

        // Set once the client hangs up — no one left to answer.
        let clientGone = false;

        // Busboy can error after the last part settled; only the first outcome wins.
        let handedOff = false;
        const handOff = err => {
          if (handedOff || clientGone) return;
          handedOff = true;
          next(err);
        };

        // Abort a doomed single upload without draining the rest of the body,
        // so the client's transfer stops early.
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

        // Track every successful PUT so a later controller rejection can delete them.
        if (!req._s3UploadedKeys) {
          req._s3UploadedKeys = [];

          // Auto-cleanup: delete tracked objects when the response is an error.
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
          // Collect repeated fields (relativePaths, clientIds) into arrays.
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

          // Sniff the type from content (the header/filename can lie); never
          // blocks, and falls back to the declared type when unrecognisable.
          let detectedMimeType = null;
          const sniffStream = createMimeSniffStream(mime => {
            detectedMimeType = mime;
          });
          const { stream: counterStream, getByteCount } = createByteCountStream();
          const encryptStream = createEncryptStream();

          let failed = false;

          // Record the rejection and unwind the streams: a destroyed transform
          // doesn't end downstream, so the put would hang; draining the part
          // lets busboy move on to the remaining files.
          const failFile = (err, message, level = 'warn') => {
            if (failed || clientGone) return;
            failed = true;
            hadError = true;
            const reason = describeFailure(err);
            fileFailures.push({ fileName: filename, error: reason, index: currentIndex });
            logger[level]({ err, storageName, filename }, message);
            if (!sniffStream.destroyed) sniffStream.destroy(err);
            fileStream.unpipe(sniffStream);
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

          // A teardown error with no real reason of its own; let the put speak first.
          let shrapnel = null;

          fileStream.pipe(sniffStream);
          // pipeline (not pipe) so a rejected file tears down the chain and the
          // put rejects instead of hanging on a stream that stopped early.
          const chainSettled = pipeline(sniffStream, counterStream, encryptStream).catch(err => {
            // A dying destination reports its teardown as an abort; recording it
            // would bury the real storage error, so defer to the put a tick later.
            if (isShrapnel(err)) {
              shrapnel = err;
              return;
            }
            failFile(err, '[StreamUpload] Upload stream failed');
          });

          fileStream.on('error', err => failFile(err, '[StreamUpload] File stream error'));

          // Capture both outcomes as values so the verdict waits for each — a put
          // can report success before the chain's abort surfaces, and judging on
          // whichever lands first would store a truncated file as a whole one.
          const putSettled = storage.putStream(storageName, encryptStream).then(
            () => null,
            err => err
          );

          Promise.all([putSettled, chainSettled])
            .then(([putError]) => {
              if (clientGone) {
                // No row is written for an abandoned request; a stored object is an orphan.
                if (!putError) cleanupS3Keys([storageName]);
                return;
              }
              if (putError) {
                failFile(putError, '[StreamUpload] Upload failed', 'error');
                return;
              }
              if (failed || shrapnel) {
                // Put beat the rejection, or called an early-ended body a success.
                // Neither is worth keeping; the stored object is an orphan.
                cleanupS3Keys([storageName]);
                if (shrapnel) failFile(shrapnel, '[StreamUpload] Upload stream ended early');
                return;
              }
              const size = getByteCount();
              req._s3UploadedKeys.push(storageName);
              uploadsByIndex[currentIndex] = {
                id,
                storageName,
                name: filename,
                size,
                mimeType: detectedMimeType || mimeType || 'application/octet-stream',
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

          // The response never finishes, so the res.finish sweeper won't run —
          // clean up whatever already reached storage here.
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
            // The controller folds these into its per-file failures for the client.
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
          // The parser seeing the body stop mid-part — what a cancel looks like.
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
