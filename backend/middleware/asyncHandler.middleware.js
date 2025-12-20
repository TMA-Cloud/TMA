/**
 * Async error handler wrapper for Express route handlers
 * 
 * This middleware wraps async route handlers to automatically catch
 * any unhandled promise rejections and pass them to Express error handler.
 * 
 * Usage:
 *   const asyncHandler = require('./middleware/asyncHandler.middleware');
 *   router.get('/route', asyncHandler(async (req, res) => {
 *     // async code here
 *   }));
 * 
 * Note: While all controllers currently have try-catch blocks, this provides
 * an extra safety layer for any errors that might escape.
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;

