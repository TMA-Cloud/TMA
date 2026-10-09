/**
 * Response utility functions for consistent error handling
 */
import { logger } from '../config/logger.js';

/**
 * Send error response with consistent format
 * @param {Object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {Error} err - Optional error object for logging
 * @param {Object} data - Optional additional error data
 */
function sendError(res, status, message, err = null, data = null) {
  if (sendIfStorageNotConfigured(res, err)) return;
  if (err) {
    logger.error({ err }, 'Error in request handler');
  }
  const response = { message };
  if (data) {
    Object.assign(response, data);
  }
  res.status(status).json(response);
}

/**
 * Answer 503 when the error only means no bucket is connected yet: a setup
 * state, not a crash, whichever handler hit it.
 * @returns {boolean} true when a response was sent
 */
function sendIfStorageNotConfigured(res, err) {
  if (err?.code !== 'STORAGE_NOT_CONFIGURED') return false;
  res.status(503).json({ message: err.message, error: 'STORAGE_NOT_CONFIGURED' });
  return true;
}

/**
 * Send success response
 * @param {Object} res - Express response object
 * @param {*} data - Data to send
 * @param {number} status - HTTP status code (default: 200)
 */
function sendSuccess(res, data, status = 200) {
  res.status(status).json(data);
}

export { sendError, sendIfStorageNotConfigured, sendSuccess };
