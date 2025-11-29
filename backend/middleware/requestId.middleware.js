const { createNamespace } = require('cls-hooked');
const { v4: uuidv4 } = require('uuid');

// Create a continuation-local-storage namespace for request context
const requestContext = createNamespace('request-context');

/**
 * Middleware to generate and propagate request IDs throughout the application
 *
 * This middleware:
 * 1. Generates a unique UUID for each request
 * 2. Stores it in CLS (continuation-local-storage) for automatic propagation
 * 3. Adds X-Request-ID header to the response
 * 4. Makes requestId available to all downstream code without manual passing
 *
 * Usage:
 *   app.use(requestIdMiddleware);
 *
 *   // Later in any controller or service:
 *   const { getRequestId, getUserId } = require('./middleware/requestId.middleware');
 *   logger.info(getRequestId()); // Access requestId anywhere
 */
function requestIdMiddleware(req, res, next) {
  requestContext.run(() => {
    // Generate unique request ID (or use existing if provided by client)
    const requestId = req.headers['x-request-id'] || uuidv4();

    // Store in CLS namespace
    requestContext.set('requestId', requestId);

    // Add to response header for client-side correlation
    res.setHeader('X-Request-ID', requestId);

    // Also attach to req object for easy access
    req.requestId = requestId;

    next();
  });
}

/**
 * Get the current request ID from CLS context
 * @returns {string|null} The request ID or null if not in request context
 */
function getRequestId() {
  return requestContext.get('requestId') || null;
}

/**
 * Get the current user ID from CLS context
 * @returns {string|null} The user ID or null if not authenticated
 */
function getUserId() {
  return requestContext.get('userId') || null;
}

/**
 * Set the user ID in CLS context (called by auth middleware after JWT verification)
 * @param {string} userId - The authenticated user's ID
 */
function setUserId(userId) {
  requestContext.set('userId', userId);
}

/**
 * Get the entire CLS namespace (for advanced use cases)
 * @returns {Object} The CLS namespace
 */
function getNamespace() {
  return requestContext;
}

module.exports = {
  requestIdMiddleware,
  getRequestId,
  getUserId,
  setUserId,
  getNamespace,
};
