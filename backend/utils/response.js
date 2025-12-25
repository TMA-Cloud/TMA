/**
 * Response utility functions for consistent error handling
 */
const { logger } = require('../config/logger');

/**
 * Send error response with consistent format
 * @param {Object} res - Express response object
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 * @param {Error} err - Optional error object for logging
 */
function sendError(res, status, message, err = null) {
  if (err) {
    logger.error({ err }, 'Error in request handler');
  }
  res.status(status).json({ message });
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

module.exports = {
  sendError,
  sendSuccess,
};
