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
 * @param {Object} data - Optional additional error data
 */
function sendError(res, status, message, err = null, data = null) {
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
