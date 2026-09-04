/**
 * Controller helper utilities
 * Common patterns used across controllers
 */

import { validateId, validateIdArray } from './validation.js';
import { logAuditEvent } from '../services/auditLogger.js';
import { logger } from '../config/logger.js';

/**
 * Validate and get parent ID from request body or query
 * @param {Object} req - Express request object
 * @param {string} source - 'body' or 'query' (default: 'body')
 * @returns {Object} { valid: boolean, parentId: string|null, error: string|null }
 */
function validateParentId(req, source = 'body') {
  const sourceObj = source === 'query' ? req.query : req.body;
  const parentId = sourceObj.parentId;

  if (!parentId) {
    return { valid: true, parentId: null, error: null };
  }

  const validatedId = validateId(parentId);
  if (!validatedId) {
    return { valid: false, parentId: null, error: 'Invalid parent ID' };
  }

  return { valid: true, parentId: validatedId, error: null };
}

/**
 * Validate file/folder IDs from request body
 * @param {Object} req - Express request object
 * @returns {Object} { valid: boolean, ids: string[]|null, error: string|null }
 */
function validateFileIds(req) {
  const { ids } = req.body;
  const validatedIds = validateIdArray(ids);

  if (!validatedIds) {
    return { valid: false, ids: null, error: 'Invalid ids array' };
  }

  return { valid: true, ids: validatedIds, error: null };
}

/**
 * Validate a single ID from request params or body
 * @param {Object} req - Express request object
 * @param {string} paramName - Parameter name (default: 'id')
 * @param {string} source - 'params' or 'body' (default: 'params')
 * @returns {Object} { valid: boolean, id: string|null, error: string|null }
 */
function validateSingleId(req, paramName = 'id', source = 'params') {
  const sourceObj = source === 'body' ? req.body : req.params;
  const id = sourceObj[paramName];
  const validatedId = validateId(id);

  if (!validatedId) {
    return { valid: false, id: null, error: `Invalid ${paramName}` };
  }

  return { valid: true, id: validatedId, error: null };
}

/**
 * Record an audit event for an operation applied to a batch of files.
 *
 * Move, copy, trash, restore and permanent-delete all report the same shape:
 * the batch is attributed to its first item, and the full id/name/type lists go
 * into the metadata so the event stays readable without a join.
 *
 * @param {string} action - Audit action name (e.g. 'file.move').
 * @param {Object} batch
 * @param {string[]} batch.ids - Affected file ids.
 * @param {string[]} batch.fileNames - Names, index-aligned with ids.
 * @param {string[]} batch.fileTypes - Types ('file' | 'folder'), index-aligned with ids.
 * @param {Object} [batch.metadata] - Extra metadata merged into the event.
 * @param {Object} req - Express request object.
 */
async function logBulkFileAudit(action, { ids, fileNames, fileTypes, metadata = {} }, req) {
  await logAuditEvent(
    action,
    {
      status: 'success',
      // Attribute the batch to the actual type of its first item (file/folder).
      resourceType: fileTypes[0] || 'file',
      resourceId: ids[0],
      metadata: {
        fileCount: ids.length,
        fileIds: ids,
        fileNames,
        fileTypes,
        ...metadata,
      },
    },
    req
  );
}

/**
 * True when the client opted into a streamed NDJSON progress response
 * (`Accept: application/x-ndjson`). Callers without it get the normal JSON reply,
 * so existing consumers and tests are unaffected.
 */
function wantsProgressStream(req) {
  return String(req.headers?.accept || '').includes('application/x-ndjson');
}

// Cap the number of progress updates so a huge selection can't spam the client,
// while keeping each batch large enough that we don't multiply per-batch overhead
// (recursive id expansion + cache invalidation) for ordinary selections. A batch
// below this size is a single fast operation, so the bar just jumps 0→100.
const MAX_PROGRESS_STEPS = 20;
const MIN_BATCH_SIZE = 25;

/** Batch size that bounds both the step count and per-batch overhead (see constants above). */
function defaultBatchSize(total) {
  return Math.max(MIN_BATCH_SIZE, Math.ceil(total / MAX_PROGRESS_STEPS));
}

/**
 * Run a bulk operation over `ids` in batches, streaming one NDJSON line of real
 * progress per batch, then a final `done` line carrying `finalize()`'s payload.
 * Progress is tied to actual completion — each batch line is written only after
 * `processChunk` for that batch resolves. Errors after streaming has begun are
 * reported as a trailing `error` line (headers are already sent), never thrown.
 *
 * @param {Object} res - Express response.
 * @param {Object} opts
 * @param {string[]} opts.ids - Items to process, in order.
 * @param {(chunk: string[]) => Promise<void>} opts.processChunk - Handles one batch.
 * @param {() => Promise<Object>} [opts.finalize] - Runs after all batches; its result is spread into the `done` line.
 * @param {number} [opts.chunkSize] - Batch size; defaults to {@link defaultBatchSize}.
 */
async function streamBulkProgress(res, { ids, processChunk, finalize, chunkSize }) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Content-Type-Options': 'nosniff',
    'X-Accel-Buffering': 'no', // don't let a proxy buffer away the progress
  });
  // Get headers (and the first line) to the client immediately rather than
  // waiting for the OS/Node to fill a buffer.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const total = ids.length;
  let done = 0;
  const write = obj => {
    res.write(`${JSON.stringify(obj)}\n`);
    if (typeof res.flush === 'function') res.flush(); // flush past any compression middleware
  };

  try {
    write({ type: 'progress', done, total });
    const size = chunkSize && chunkSize > 0 ? chunkSize : defaultBatchSize(total);
    for (let i = 0; i < total; i += size) {
      const chunk = ids.slice(i, i + size);
      await processChunk(chunk);
      done += chunk.length;
      write({ type: 'progress', done, total });
    }
    const payload = finalize ? await finalize() : {};
    write({ type: 'done', ...payload });
  } catch (err) {
    logger.error({ err }, 'Streaming bulk operation failed mid-flight');
    write({ type: 'error', message: err && err.message ? err.message : 'Operation failed' });
  } finally {
    res.end();
  }
}

export {
  validateParentId,
  validateFileIds,
  validateSingleId,
  logBulkFileAudit,
  wantsProgressStream,
  streamBulkProgress,
};
