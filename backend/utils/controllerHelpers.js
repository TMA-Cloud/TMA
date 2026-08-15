/**
 * Controller helper utilities
 * Common patterns used across controllers
 */

import { validateId, validateIdArray } from './validation.js';
import { logAuditEvent } from '../services/auditLogger.js';

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

export { validateParentId, validateFileIds, validateSingleId, logBulkFileAudit };
