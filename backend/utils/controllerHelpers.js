/**
 * Controller helper utilities
 * Common patterns used across controllers
 */

const { validateId, validateIdArray } = require('./validation');

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

module.exports = {
  validateParentId,
  validateFileIds,
  validateSingleId,
};
