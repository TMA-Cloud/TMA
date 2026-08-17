import { AsyncLocalStorage } from 'node:async_hooks';

import { nanoid } from 'nanoid';

// Per-request store, carried across await points by the runtime itself.
const requestContext = new AsyncLocalStorage();

/**
 * Run a callback with a fresh request context active. Everything it starts,
 * including work resuming after an await, sees the same store.
 *
 * @param {Function} fn - Callback; its return value is passed straight through.
 * @param {Object} [seed] - Initial context values.
 * @param {string} [seed.requestId]
 */
function runInRequestContext(fn, { requestId = nanoid() } = {}) {
  return requestContext.run(new Map([['requestId', requestId]]), fn);
}

/**
 * The store for the in-flight request. Reads tolerate its absence (background
 * jobs have no request); writes must not, or audit records end up attributed
 * to no one.
 *
 * @param {string} setter - Name used in the error message.
 */
function activeStore(setter) {
  const store = requestContext.getStore();
  if (!store) {
    throw new Error(`${setter}() called outside a request context. Is requestIdMiddleware mounted?`);
  }
  return store;
}

// The client's id is echoed into a response header and stamped on every log
// line, so only accept a shape that can't disrupt either: bounded, and without
// the delimiters headers and log parsers key on.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Take the client's trace id only if it is well formed, otherwise mint one.
 * @param {unknown} headerValue - Raw x-request-id header.
 * @returns {string}
 */
function resolveRequestId(headerValue) {
  return typeof headerValue === 'string' && SAFE_REQUEST_ID.test(headerValue) ? headerValue : nanoid();
}

/**
 * Middleware to generate and propagate request IDs throughout the application
 *
 * This middleware:
 * 1. Generates a unique ID for each request (or reuses the client's)
 * 2. Stores it in AsyncLocalStorage for automatic propagation
 * 3. Adds X-Request-ID header to the response
 * 4. Makes requestId available to all downstream code without manual passing
 *
 * Usage:
 *   app.use(requestIdMiddleware);
 *
 *   // Later in any controller or service:
 *   import { getRequestId, getUserId } from './middleware/requestId.middleware.js';
 *   logger.info(getRequestId()); // Access requestId anywhere
 */
function requestIdMiddleware(req, res, next) {
  const requestId = resolveRequestId(req.headers['x-request-id']);

  // Add to response header for client-side correlation
  res.setHeader('X-Request-ID', requestId);

  // Also attach to req object for easy access
  req.requestId = requestId;

  runInRequestContext(next, { requestId });
}

/**
 * Get the current request ID from the request context
 * @returns {string|null} The request ID or null if not in request context
 */
function getRequestId() {
  return requestContext.getStore()?.get('requestId') ?? null;
}

/**
 * Get the current user ID from the request context
 * @returns {string|null} The user ID or null if not authenticated
 */
function getUserId() {
  return requestContext.getStore()?.get('userId') ?? null;
}

/**
 * Set the user ID in the request context (called by auth middleware after JWT verification)
 * @param {string} userId - The authenticated user's ID
 */
function setUserId(userId) {
  activeStore('setUserId').set('userId', userId);
}

/**
 * Get the account context (owner ID + role) from the request context.
 * Set by the auth middleware once the acting user has been resolved.
 * @returns {{ownerId: string, role: string}|null}
 */
function getAccountContext() {
  return requestContext.getStore()?.get('accountContext') ?? null;
}

/**
 * Set the account context (called by auth middleware).
 * @param {{ownerId: string, role: string}} context
 */
function setAccountContext(context) {
  activeStore('setAccountContext').set('accountContext', context);
}

export {
  requestIdMiddleware,
  runInRequestContext,
  getRequestId,
  getUserId,
  setUserId,
  getAccountContext,
  setAccountContext,
};
